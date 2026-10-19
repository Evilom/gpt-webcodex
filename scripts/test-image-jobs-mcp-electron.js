'use strict';
// Default is an offline fixture. --live --integration <file> --id <stable-id>
// uses the already authorized local runner once; no production profile is opened.
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const live = process.argv.includes('--live');
const option = name => process.argv[process.argv.indexOf(name) + 1];
const archive = process.argv.includes('--archive') ? path.resolve(option('--archive')) : '';
const codeRoot = archive || root;
const { ImageJobService } = require(path.join(codeRoot, 'electron/services/imageJobService'));
const { AdvisoryBridge } = require(path.join(codeRoot, 'electron/services/advisoryBridge'));
const { LocalMcpClient } = require(path.join(codeRoot, 'electron/services/localMcpClient'));
if (live && (!process.argv.includes('--integration') || !process.argv.includes('--id'))) throw new Error('Live verification requires an integration file and stable job ID.');
const id = live ? option('--id') : `image_smoke_${crypto.randomUUID()}`;
const output = process.env.IMAGE_JOB_TEST_OUTPUT || path.join(root, 'build/image-jobs-mcp-test.json');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'thinktank-image-mcp-'));
app.setPath('userData', path.join(directory, 'electron-profile'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, bridge, fixtureTimer;
const token = crypto.randomBytes(24).toString('hex');
let postCount = 0;

async function startRuntime(service) {
  bridge = new AdvisoryBridge({ service: { status: () => ({}) }, imageService: service, secrets: { get: () => token }, port: 0 });
  const address = await bridge.start();
  const allocator = http.createServer(); await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve));
  const port = allocator.address().port; await new Promise(resolve => allocator.close(resolve));
  const resourceRoot = archive ? path.join(path.dirname(archive), 'resources') : path.join(root, 'resources');
  const python = process.platform === 'win32' ? path.join(resourceRoot, 'native-python/python.exe') : path.join(resourceRoot, archive ? 'native-python/bin/python3' : 'mac-arm64/native-python/bin/python3');
  const mcp = path.join(resourceRoot, 'coding-tools-mcp');
  child = spawn(python, ['-B', '-m', 'coding_tools_mcp', '--workspace', directory, '--host', '127.0.0.1', '--port', String(port), '--permission-mode', 'dangerous'], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: [path.join(mcp, 'python_vendor'), mcp].join(path.delimiter),
      CODING_TOOLS_MCP_MEMORY_ROOT: path.join(directory, 'memory'), CODING_TOOLS_MCP_AUTH_MODE: 'bearer', CODING_TOOLS_MCP_AUTH_TOKEN: token,
      CODING_TOOLS_MCP_TOOL_MODE: 'smart', CODING_TOOLS_MCP_ADVISORY_URL: address }
  });
  const client = new LocalMcpClient({ port, token });
  let healthy = false;
  for (let i = 0; i < 60; i++) { try { await client.healthStatus(); healthy = true; break; } catch { await delay(100); } }
  assert.equal(healthy, true, 'isolated runtime starts');
  await client.discoverTools();
  assert.equal(client.schemaIdentity().schemaVersion, 16);
  assert.equal(client.schemaIdentity().toolCount, 12);
  return client;
}
async function stopRuntime() {
  if (child) {
    const current = child; child = null;
    if (current.exitCode === null) { const exited = new Promise(resolve => current.once('exit', resolve)); current.kill(); await exited; }
  }
  if (bridge) { const current = bridge; bridge = null; await current.stop(); }
}

app.whenReady().then(async () => {
  const config = live ? JSON.parse(fs.readFileSync(option('--integration'), 'utf8').replace(/^\uFEFF/, '')) : {
    name: 'local-cliproxy-material-jobs', version: 1, proxy_base_url: 'http://127.0.0.1:8317/v1',
    job_runner: path.join(directory, 'jobs.py'), python: process.execPath
  };
  let record;
  const run = live ? undefined : async (_python, args) => {
    if (args[2] === 'submit') {
      postCount++;
      const jobDir = path.join(directory, 'jobs', id); fs.mkdirSync(jobDir, { recursive: true });
      fs.writeFileSync(path.join(jobDir, 'request.json'), JSON.stringify({ kind: 'image', model: 'gpt-image-2', size: args[args.indexOf('--size') + 1], prompt: fs.readFileSync(args.at(-1), 'utf8') }));
      record = { id, kind: 'image', status: 'running', created_at: new Date().toISOString() };
      fixtureTimer = setTimeout(() => {
        const image = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
        const png = image.toPNG(); fs.writeFileSync(path.join(jobDir, 'image.png'), png);
        fs.writeFileSync(path.join(jobDir, 'preview.jpg'), image.toJPEG(70));
        record = { ...record, status: 'succeeded', dimensions: [1, 1], sha256: crypto.createHash('sha256').update(png).digest('hex') };
      }, 800);
      return { stdout: JSON.stringify({ id, status: 'submitted' }) };
    }
    return { stdout: JSON.stringify(args.length === 3 ? (record ? [record] : []) : record) };
  };
  if (!live) fs.writeFileSync(config.job_runner, '# offline fixture entry');
  let service = new ImageJobService({ directory, ...(run ? { run } : {}) });
  await service.importConfiguration(config); service.select(true);
  let client = await startRuntime(service);
  const call = async args => {
    const result = await client.callTool('image_jobs', args);
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent.ok, true, JSON.stringify(result.structuredContent));
    return result;
  };
  const brief = { action: 'submit', request_id: id, title: '异步生图接入验证', size: '1024x1024',
    prompt: 'Create one clean reference card on an off-white background: three simple shaded geometric objects, a sphere, a cube and a cylinder, neatly spaced horizontally. Restrained graphite gray with one small coral accent. Crisp studio lighting. No text, no letters, no logo. This is a software integration test image.' };
  const started = Date.now();
  const submitted = (await call(brief)).structuredContent;
  const submitElapsedMs = Date.now() - started;
  assert.equal(submitted.id, id); assert.ok(submitElapsedMs < 3000, 'submission must not wait for image generation');
  assert.equal((await call(brief)).structuredContent.deduplicated, true);
  const pingStarted = Date.now(); await client.ping();
  const pingElapsedMs = Date.now() - pingStarted;
  const beforeRestart = (await call({ action: 'result', job_id: id })).structuredContent;
  assert.ok(['queued', 'running', 'succeeded'].includes(beforeRestart.status));
  const commandStarted = Date.now();
  const command = await client.callTool('exec_command', { cmd: 'echo image-main-task-continues', yield_time_ms: 1000, max_output_bytes: 1024, verbosity: 'full' });
  assert.equal(command.isError, false, JSON.stringify(command.structuredContent));
  assert.ok(JSON.stringify(command.content).includes('image-main-task-continues'));
  const mainCommandElapsedMs = Date.now() - commandStarted;
  await stopRuntime();
  // Recreate the desktop bridge and MCP while the independent worker continues.
  service = new ImageJobService({ directory, ...(run ? { run } : {}) });
  client = await startRuntime(service);
  let result;
  for (let i = 0; i < 30; i++) {
    result = (await call({ action: 'result', job_id: id })).structuredContent;
    console.log(JSON.stringify({ id, status: result.status }));
    if (['succeeded', 'failed', 'interrupted'].includes(result.status)) break;
    await client.ping(); await delay(live ? 15000 : 100);
  }
  assert.equal(result.status, 'succeeded', result.error);
  const original = await service.assetPath(id);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(original)).digest('hex');
  assert.equal(digest, result.sha256);
  assert.deepEqual(Object.values(nativeImage.createFromPath(original).getSize()), result.dimensions);
  const preview = await call({ action: 'preview', job_id: id });
  const image = preview.content.find(item => item.type === 'image');
  assert.ok(image?.data); assert.ok(Buffer.byteLength(image.data, 'base64') <= 200000);
  assert.equal(preview.structuredContent._mcp_image_data, undefined);
  service.select(false);
  assert.equal((await call({ action: 'result', job_id: id })).structuredContent.status, 'succeeded');
  if (!live) assert.equal(postCount, 1);
  const report = { ok: true, live, packaged: Boolean(archive), id, submitElapsedMs, pingElapsedMs, mainCommandElapsedMs, survivedBridgeAndRuntimeRestart: true,
    stateBeforeRestart: beforeRestart.status, postCount: live ? 'deduplicated-original-id' : postCount,
    result, previewBytes: Buffer.byteLength(image.data, 'base64'), schema: client.schemaIdentity() };
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, live, id, submitElapsedMs, pingElapsedMs, previewBytes: report.previewBytes, output }));
}).catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await stopRuntime(); if (fixtureTimer) clearTimeout(fixtureTimer);
  // Keep failed/live state as evidence. All directories are isolated from production.
  if (!process.exitCode && !live) fs.rmSync(directory, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
