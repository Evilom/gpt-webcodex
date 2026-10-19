const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ImageJobService } = require('../electron/services/imageJobService');
const { AdvisoryBridge } = require('../electron/services/advisoryBridge');

async function fixture(t, run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'thinktank-image-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runner = path.join(directory, 'jobs.py'), python = path.join(directory, 'python');
  await fs.writeFile(runner, 'fixture'); await fs.writeFile(python, 'fixture');
  const execute = async (python, args, options) => {
    if (args[2] === 'submit') {
      const jobDir = path.join(directory, 'jobs', args[args.indexOf('--id') + 1]); await fs.mkdir(jobDir, { recursive: true });
      const request = { kind: 'image', model: 'gpt-image-2', size: args[args.indexOf('--size') + 1], prompt: await fs.readFile(args.at(-1), 'utf8') };
      try { await fs.writeFile(path.join(jobDir, 'request.json'), JSON.stringify(request), { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return run(python, args, options);
  };
  const service = new ImageJobService({ directory, run: execute });
  const config = { name: 'local-cliproxy-material-jobs', version: 1, proxy_base_url: 'http://127.0.0.1:8317/v1', job_runner: runner, python };
  await service.importConfiguration(config);
  return { directory, service, config };
}
const brief = { request_id: 'image_job_001', prompt: '一个清楚的资料板', title: '资料板', size: '1536x1024' };

test('desktop paging reaches old assets, isolates active jobs and retains the selected detail across reordering', async t => {
  const jobs = Array.from({ length: 63 }, (_, index) => ({ id: `history_image_${index}`, kind: 'image', status: index === 62 ? 'running' : 'succeeded', created_at: String(index).padStart(3, '0') }));
  const { service } = await fixture(t, async (_python, args) => {
    assert.deepEqual(args.slice(2), ['status'], 'paging only reads existing jobs');
    return { stdout: JSON.stringify(jobs) };
  });
  const first = await service.list(5);
  assert.equal(first.jobs.length, 5); assert.equal(first.total, 63); assert.equal(first.jobs[0].id, 'history_image_62');
  const seen = new Set();
  for (let offset = 0; offset < 63; offset += 5) {
    const page = await service.list(5, { offset });
    for (const job of page.jobs) { assert.equal(seen.has(job.id), false); seen.add(job.id); }
  }
  assert.equal(seen.size, 63, 'history is not truncated at the old 30/50-task limit');
  const history = await service.list(5, { filter: 'history', offset: 9999, selected_id: 'history_image_62' });
  assert.equal(history.offset, 60); assert.equal(history.filtered_total, 62);
  assert.ok(history.jobs.every(job => job.status === 'succeeded'));
  assert.equal(history.selected_job.status, 'running', 'selected detail remains addressable outside the current page');
  const active = await service.list(5, { filter: 'active', offset: 20 });
  assert.equal(active.offset, 0); assert.equal(active.jobs.length, 1);
  jobs[62].status = 'succeeded';
  const completed = await service.list(5, { filter: 'active', selected_id: jobs[62].id });
  assert.equal(completed.filtered_total, 0); assert.equal(completed.selected_job.status, 'succeeded');
  assert.equal((await service.list()).jobs.length, 30, 'public MCP defaults remain unchanged');
});

test('image extension requires an explicit switch, keeps credentials external and bounds UTF-8 input', async t => {
  let calls = 0;
  const { service, config } = await fixture(t, async () => { calls++; });
  await assert.rejects(service.submit(brief), /未启用/);
  await assert.rejects(service.importConfiguration({ ...config, proxy_base_url: 'http://remote.example/v1' }));
  service.select(true);
  await assert.rejects(service.submit({ ...brief, prompt: '汉'.repeat(8001) }), /24000/);
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(service.status()).includes('api_key'), false);
});

test('same exact job submits once, returns promptly and survives desktop service recreation', async t => {
  let calls = 0, received;
  const run = async (python, args, options) => {
    calls++; received = { python, args, options };
    await new Promise(resolve => setTimeout(resolve, 30));
    return { stdout: JSON.stringify({ id: brief.request_id, kind: 'image', status: args[2] === 'submit' ? 'submitted' : 'running' }) };
  };
  const { service, directory } = await fixture(t, run); service.select(true);
  const [first, duplicate] = await Promise.all([service.submit(brief), service.submit(brief)]);
  assert.equal(first.status, 'queued'); assert.equal(first.can_continue_main_task, true);
  assert.equal(duplicate.deduplicated, true); assert.equal(calls, 1);
  assert.equal(received.options.shell, false); assert.equal(received.options.windowsHide, true);
  assert.equal(await fs.readFile(received.args.at(-1), 'utf8'), brief.prompt);
  await assert.rejects(service.submit({ ...brief, prompt: '另一个提示词' }), /相同任务编号/);
  const restored = new ImageJobService({ directory, run: service.run });
  assert.equal((await restored.submit(brief)).status, 'running');
  assert.equal(calls, 2); assert.equal(received.args[2], 'status');
  service.select(false);
  assert.equal((await service.result(brief.request_id)).status, 'running');
});

test('ambiguous delivery remains visible and never silently resubmits', async t => {
  let submits = 0;
  const { service, directory } = await fixture(t, async (_python, args) => {
    if (args[2] === 'submit') { submits++; throw new Error('timeout'); }
    if (args.length === 3) return { stdout: '[]' };
    throw new Error('not found');
  }); service.select(true);
  assert.equal((await service.submit(brief)).status, 'submission_unknown');
  const listed = await service.list();
  assert.equal(listed.jobs[0].id, brief.request_id); assert.equal(listed.active_count, 0); assert.equal(listed.unconfirmed_count, 1);
  const restored = new ImageJobService({ directory, run: service.run });
  assert.equal((await restored.submit(brief)).status, 'submission_unknown');
  assert.equal(submits, 1);
});

test('asset view is restricted to the original job directory and preview stays under 200 KB', async t => {
  const { service, directory } = await fixture(t, async () => ({ stdout: JSON.stringify({ id: brief.request_id, kind: 'image', status: 'succeeded', file: '/untrusted/secret', dimensions: [1024, 1024] }) }));
  const jobDir = path.join(directory, 'jobs', brief.request_id); await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, 'image.png'), 'test-raster-path-only');
  await fs.writeFile(path.join(jobDir, 'preview.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal(await service.assetPath(brief.request_id), await fs.realpath(path.join(jobDir, 'image.png')));
  const result = await service.agentCall({ action: 'result', job_id: brief.request_id });
  assert.equal(result.review_status, 'pending'); assert.equal(result.data, undefined);
  assert.equal((await service.preview(brief.request_id)).mime_type, 'image/jpeg');
  await fs.writeFile(path.join(jobDir, 'preview.jpg'), Buffer.alloc(200001));
  await assert.rejects(service.preview(brief.request_id), /预算/);
  await assert.rejects(service.assetPath('../outside'));
});

test('a pre-existing CLI job with a different prompt cannot masquerade as the new asset', async t => {
  const existing = { id: brief.request_id, kind: 'image', status: 'succeeded' };
  const { service, directory } = await fixture(t, async (_python, args) => {
    if (args[2] === 'submit') throw new Error('same ID belongs to another request');
    return { stdout: JSON.stringify(args.length === 3 ? [existing] : existing) };
  });
  const jobDir = path.join(directory, 'jobs', brief.request_id); await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, 'request.json'), JSON.stringify({ kind: 'image', prompt: '完全不同的旧提示词', model: 'gpt-image-2', size: brief.size }));
  service.select(true); await service.submit(brief);
  assert.equal((await service.result(brief.request_id)).status, 'failed');
  assert.equal((await service.list()).jobs[0].file, undefined);
  await assert.rejects(service.preview(brief.request_id), /尚未生成/);
});

test('a job junction cannot turn the asset viewer into an arbitrary local file opener', async t => {
  const { service, directory } = await fixture(t, async () => ({ stdout: JSON.stringify({ id: brief.request_id, kind: 'image', status: 'succeeded' }) }));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'image-outside-')); t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'image.png'), 'outside'); await fs.mkdir(path.join(directory, 'jobs'));
  await fs.symlink(outside, path.join(directory, 'jobs', brief.request_id), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.assetPath(brief.request_id), /路径/);
});

test('the existing local bridge routes image calls separately with the same authentication checks', async t => {
  let calls = 0;
  const bridge = new AdvisoryBridge({ port: 0, secrets: { get: () => 'fixture-token' }, service: { agentCall() { throw new Error('wrong route'); } },
    imageService: { agentCall: async () => { calls++; return { enabled: true }; }, status: () => ({}) } });
  const advisoryUrl = await bridge.start(); t.after(() => bridge.stop());
  const url = advisoryUrl.replace('/advisory', '/image-jobs');
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  const headers = { Authorization: 'Bearer fixture-token' };
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://chatgpt.com' }, body: '{}' })).status, 403);
  assert.equal((await (await fetch(url, { method: 'POST', headers, body: '{}' })).json()).enabled, true);
  assert.equal(calls, 1);
});
