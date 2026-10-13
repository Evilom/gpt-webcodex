const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AdvisoryService, inputBytes } = require('../electron/services/advisoryService');
function setup(t, fetchImpl) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'think-tank-advisory-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entries = {};
  const service = new AdvisoryService({ directory, secrets: { get: (name) => entries[name] || '', set: (name, value) => { entries[name] = value; } }, fetchImpl });
  service.importConfiguration({ base_url: 'https://assist.example', api_key: 'fixture-secret' });
  return { service, directory };
}
test('directory comes from the common service and preferences do not persist credentials', async (t) => {
  const { service, directory } = setup(t, async () => ({ ok: true, json: async () => ({ models: [{ id: 'anthropic::claude-opus-5-5', name: 'Opus 5.5' }, { id: 'google::gemini-3.8-flash-high', name: 'Flash High' }] }) }));
  await service.catalog();
  assert.deepEqual(service.status().selected, []);
  service.select(['anthropic::claude-opus-5-5', 'google::gemini-3.8-flash-high']);
  assert.equal(service.status().selected.length, 2);
  assert.throws(() => service.select(['imaginary']), /实际存在/);
  assert.doesNotMatch(fs.readFileSync(path.join(directory, 'extensions.json'), 'utf8'), /fixture-secret/);
  assert.doesNotMatch(JSON.stringify(service.status()), /fixture-secret/);
});
test('one explicit question produces one job, polling never resubmits', async (t) => {
  const calls = [];
  const { service } = setup(t, async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/models') ? { models: [{ id: 'anthropic::claude-opus-5-5' }] } : url.endsWith('/status') ? {} : { id: 'job_fixture_123', status: options.method === 'POST' ? 'queued' : 'completed', responses: [] } };
  });
  await service.catalog();
  service.select(['anthropic::claude-opus-5-5']);
  await service.submit({ request_id: 'job_fixture_123', question: '分析这份设计，不执行命令' });
  await service.submission;
  await assert.rejects(service.submit({ request_id: 'job_fixture_456', question: '重复请求' }), /已有辅助咨询/);
  await service.result();
  assert.equal(calls.filter((item) => item.options.method === 'POST').length, 1);
  const payload = JSON.parse(calls.find((item) => item.options.method === 'POST').options.body);
  assert.equal(payload.question, '分析这份设计，不执行命令');
  assert.deepEqual(payload.context, []);
  assert.equal(service.status().job.status, 'completed');
});
test('an ambiguous timeout retains the request ID and blocks automatic replay', async (t) => {
  const { service } = setup(t, async (url) => {
    if (url.endsWith('/models')) return { ok: true, json: async () => ({ models: [{ id: 'anthropic::claude-opus-5-5' }] }) };
    if (url.endsWith('/status')) return { ok: true, json: async () => ({}) };
    throw new Error('timeout');
  });
  await service.catalog();
  service.select(['anthropic::claude-opus-5-5']);
  await service.submit({ request_id: 'ambiguous_job_123', question: '独立咨询' });
  await service.submission;
  assert.equal(service.status().job.status, 'submitting');
  assert.match(service.status().job.error, /timeout/);
  assert.match(service.status().job.request_id, /^[\w-]+$/);
  await assert.rejects(service.submit({ request_id: 'ambiguous_job_456', question: '重放' }), /已有辅助咨询/);
});

test('submission returns immediately, uses only selected models and deduplicates the same brief', async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let posts = 0;
  const { service } = setup(t, async (url, options) => {
    if (url.endsWith('/status')) await gate;
    if (options.method === 'POST') posts++;
    return { ok: true, json: async () => url.endsWith('/models') ? { models: [{ id: 'anthropic::claude-opus-5-5' }] } : { id: 'quick_job_123', status: 'completed' } };
  });
  await service.catalog(); service.select(['anthropic::claude-opus-5-5']);
  const brief = { request_id: 'quick_job_123', question: '分析网页与子进程的恢复方案', context: [{ id: 'proposal', text: '保留健康子进程。' }] };
  assert.equal((await service.submit(brief)).status, 'preparing');
  assert.equal(posts, 0);
  assert.equal((await service.submit(brief)).deduplicated, true);
  await assert.rejects(service.submit({ ...brief, question: '另一项问题' }), /不同咨询内容/);
  release(); await service.submission;
  assert.equal(posts, 1);
  assert.equal((await service.submit(brief)).deduplicated, true);
  assert.equal(posts, 1);
  await assert.rejects(service.submit({ request_id: 'disabled_job_123', question: '设计', models: ['google::gemini-3.8-flash-high'] }), /用户勾选/);
});

test('UTF-8 budget includes Chinese text, reference fences and prompt overhead without truncation', async (t) => {
  const { service } = setup(t, async () => ({ ok: true, json: async () => ({ models: [{ id: 'anthropic::claude-opus-5-5' }] }) }));
  await service.catalog(); service.select(['anthropic::claude-opus-5-5']);
  const brief = { request_id: 'unicode_job_123', question: '检查方案', context: [{ id: 'design', text: '中'.repeat(8000) }] };
  await assert.rejects(service.submit(brief), /UTF-8 字节/);
  const small = service.envelope({ ...brief, context: [{ id: 'design', text: '```\n健康子进程\n```' }] });
  assert.ok(inputBytes(small) > Buffer.byteLength(small.question + small.context[0].text));
  assert.equal(small.context[0].text, '```\n健康子进程\n```');
  await assert.rejects(service.submit({ ...brief, question: 'a'.repeat(6001), context: [] }), /6000/);
  await assert.rejects(service.submit({ ...brief, context: [{ id: 'x', text: 'a' }, { id: 'x', text: 'b' }] }), /唯一 ID/);
});

test('current server budget is checked before POST, metadata failure never triggers inference', async (t) => {
  let posts = 0;
  const { service } = setup(t, async (url, options) => {
    if (options.method === 'POST') posts++;
    return { ok: true, json: async () => url.endsWith('/models') ? { models: [{ id: 'anthropic::claude-opus-5-5' }] } : { max_input_bytes: 400 } };
  });
  await service.catalog(); service.select(['anthropic::claude-opus-5-5']);
  await service.submit({ request_id: 'small_budget_123', question: '中文材料'.repeat(50) });
  await service.submission;
  assert.equal(posts, 0); assert.equal(service.status().job.status, 'failed');
  assert.equal((await service.result()).status, 'failed');
});

test('unchecking a model during preparation prevents its submission', async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve; }); let posts = 0;
  const { service } = setup(t, async (url, options) => {
    if (url.endsWith('/status')) await gate;
    if (options.method === 'POST') posts++;
    return { ok: true, json: async () => ({ models: [{ id: 'anthropic::claude-opus-5-5' }] }) };
  });
  await service.catalog(); service.select(['anthropic::claude-opus-5-5']);
  await service.submit({ request_id: 'unchecked_job_123', question: '复核设计' });
  service.select([]); release(); await service.submission;
  assert.equal(posts, 0); assert.equal(service.status().job.status, 'failed');
});

test('explicit input rejection or full queue is terminal, not an ambiguous timeout', async (t) => {
  for (const status of [413, 429]) {
    const { service } = setup(t, async (url, options) => options.method === 'POST' ? { ok: false, status } : { ok: true, json: async () => url.endsWith('/models') ? { models: [{ id: 'anthropic::claude-opus-5-5' }] } : {} });
    await service.catalog(); service.select(['anthropic::claude-opus-5-5']);
    await service.submit({ request_id: `rejected_${status}_job`, question: '复核设计' });
    await service.submission;
    assert.equal(service.status().job.status, 'failed');
    assert.match((await service.result()).error, new RegExp(String(status)));
  }
});

test('restart does not replay a preparing or ambiguous POST job', async (t) => {
  const { service, directory } = setup(t, async () => { throw new Error('must not call'); });
  service.saveJob({ id: 'restarted_job_123', request_id: 'restarted_job_123', status: 'preparing' });
  const restarted = new AdvisoryService({ directory, secrets: service.secrets, fetchImpl: service.fetch });
  assert.equal(restarted.status().job.status, 'interrupted');
  service.saveJob({ id: 'uncertain_job_123', status: 'submitting' });
  const uncertain = new AdvisoryService({ directory, secrets: service.secrets, fetchImpl: service.fetch });
  assert.equal(uncertain.status().job.status, 'submitting');
});
test('remote insecure URLs and credential forwarding redirects are refused', (t) => {
  const { service } = setup(t, async () => {});
  assert.throws(() => service.validateBase('http://remote.example'), /HTTPS/);
  assert.throws(() => service.validateBase('https://user:pass@remote.example'), /HTTPS/);
  assert.equal(service.validateBase('http://127.0.0.1:8085'), 'http://127.0.0.1:8085');
});
