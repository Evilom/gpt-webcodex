'use strict';
// Isolated MCP caller: default is offline. --live uses only the configured test brief.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const live = process.argv.includes('--live');
const output = process.env.ADVISORY_TEST_OUTPUT || path.join(root, 'build', 'advisory-mcp-test.json');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'think-tank-mcp-test-'));
const profile = path.join(app.getPath('appData'), 'web-mcp-assistant');
app.setPath('userData', profile);
let child, bridge, service;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const { SecretStore } = require('../electron/services/secretStore');
  const { AdvisoryService } = require('../electron/services/advisoryService');
  const { AdvisoryBridge } = require('../electron/services/advisoryBridge');
  const { LocalMcpClient } = require('../electron/services/localMcpClient');
  const token = crypto.randomBytes(24).toString('hex');
  const stored = live ? new SecretStore() : null;
  const selected = ['anthropic::claude-opus-5-5', live ? 'google::gemini-3.8-flash-high' : 'google::gemini-4-argon'];
  const original = live ? JSON.parse(fs.readFileSync(path.join(profile, 'extensions.json'), 'utf8')) : { baseUrl: 'https://assist.example' };
  fs.writeFileSync(path.join(directory, 'extensions.json'), JSON.stringify({ baseUrl: original.baseUrl, selected }));
  const secrets = { get: (name) => name === 'mcpAuthToken' ? token : live ? stored.get(name) : 'fixture-key' };
  let posts = 0, requestBody;
  const fetchImpl = async (url, options) => {
    if (options.method === 'POST') { posts++; requestBody = JSON.parse(options.body); }
    if (live) return fetch(url, options);
    return { ok: true, json: async () => url.endsWith('/models') ? { models: selected.map((id) => ({ id })) } : url.endsWith('/status') ? { max_input_bytes: 24000, model_timeout_seconds: 600 } : { id: requestBody.request_id, status: options.method === 'POST' ? 'queued' : 'completed', responses: options.method === 'POST' ? [] : selected.map((model) => ({ model, status: 'answered', answer: '隔离测试建议：保留健康进程，复核握手恢复。' })) } };
  };
  service = new AdvisoryService({ directory, secrets, fetchImpl });
  bridge = new AdvisoryBridge({ service, secrets, port: 0 });
  const address = await bridge.start();
  const allocator = http.createServer();
  await new Promise((resolve) => allocator.listen(0, '127.0.0.1', resolve));
  const port = allocator.address().port;
  await new Promise((resolve) => allocator.close(resolve));
  const python = process.platform === 'win32'
    ? path.join(root, 'resources', 'native-python', 'python.exe')
    : path.join(root, 'resources', 'mac-arm64', 'native-python', 'bin', 'python3');
  const mcpRoot = path.join(root, 'resources', 'coding-tools-mcp');
  child = spawn(python, ['-B', '-m', 'coding_tools_mcp', '--workspace', directory, '--host', '127.0.0.1', '--port', String(port), '--permission-mode', 'dangerous'], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: [path.join(mcpRoot, 'python_vendor'), mcpRoot].join(path.delimiter), CODING_TOOLS_MCP_MEMORY_ROOT: path.join(directory, 'memory'),
      CODING_TOOLS_MCP_AUTH_MODE: 'bearer', CODING_TOOLS_MCP_AUTH_TOKEN: token, CODING_TOOLS_MCP_TOOL_MODE: 'smart', CODING_TOOLS_MCP_ADVISORY_URL: address }
  });
  const client = new LocalMcpClient({ port, token });
  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt++) { try { await client.healthStatus(); healthy = true; break; } catch { await delay(200); } }
  assert.equal(healthy, true, 'isolated MCP startup');
  const tools = await client.discoverTools();
  assert.ok(tools.some((item) => item.name === 'consult_advisors'));
  assert.equal(client.schemaIdentity().schemaVersion, 16);
  const call = async (args) => {
    const result = await client.callTool('consult_advisors', args);
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    for (const item of result.structuredContent.responses || []) if (item.answer) assert.ok(result.content.some((content) => content.type === 'text' && content.text.includes(item.answer)), 'AI must receive the actual advisory text');
    return result.structuredContent;
  };
  assert.equal((await call({ action: 'status' })).enabled, true);
  const requestId = `advisory_mcp_${crypto.randomUUID()}`;
  const brief = { action: 'submit', request_id: requestId, task: 'review', question: '请评审材料 proposal 中的 Electron 恢复方案，指出两个具体遗漏，并给出一个验收场景。只提供简短文字建议。',
    context: [{ id: 'proposal', text: '应用内嵌 ChatGPT 网页，另有独立 MCP 和 Tunnel 子进程。网页超时只恢复网页；MCP/Tunnel 的业务探测健康时保留原 PID；独立探测失败才恢复对应子进程。恢复过程需要避免重复执行已完成的本地操作。' }], max_output_tokens: 1000 };
  const start = Date.now();
  const submitted = await call(brief);
  const submitElapsedMs = Date.now() - start;
  assert.equal(submitted.id, requestId);
  assert.ok(submitElapsedMs < 3000, 'model generation must not block submit');
  assert.equal((await call(brief)).deduplicated, true);
  let result;
  for (let attempt = 0; attempt < 125; attempt++) {
    result = await call({ action: 'result', job_id: requestId });
    console.log(JSON.stringify({ id: requestId, status: result.status, modelsAnswered: result.responses?.filter((item) => item.status === 'answered').length || 0 }));
    if (['completed', 'partial', 'failed', 'interrupted'].includes(result.status)) break;
    await client.ping(); // Local MCP remains responsive during generation.
    await delay(live ? 10000 : 50);
  }
  assert.equal(posts, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.responses.length, 2);
  assert.ok(result.responses.every((item) => item.status === 'answered' && item.answer?.length > 20));
  assert.deepEqual(requestBody.context, brief.context);
  assert.deepEqual(requestBody.models, selected);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ ok: true, live, submitElapsedMs, totalElapsedMs: Date.now() - start, postCount: posts, schema: client.schemaIdentity(), result }, null, 2));
  console.log(`AI MCP advisory chain PASS (${live ? 'live' : 'offline'}): ${output}`);
}).catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (service?.submission) await service.submission;
  if (child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
  await bridge?.stop();
  fs.rmSync(directory, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
