const test = require('node:test');
const assert = require('node:assert/strict');
const { isSessionTerminationMessage } = require('../electron/services/localMcpClient');
const { LocalMcpClient } = require('../electron/services/localMcpClient');
const http = require('node:http');
const { probeMcpIdentity } = require('../electron/services/runtimeOrchestrator');

test('0.9.2 recognizes stale MCP session failures and ignores ordinary tool errors', () => {
  assert.equal(isSessionTerminationMessage('Session terminated'), true);
  assert.equal(isSessionTerminationMessage('MCP session not found'), true);
  assert.equal(isSessionTerminationMessage('session expired'), true);
  assert.equal(isSessionTerminationMessage('invalid MCP session'), true);
  assert.equal(isSessionTerminationMessage('tool execution failed'), false);
});

for (const kind of ['request', 'health', 'control']) test(`truncated ${kind} replies reject promptly and allow the next call`, async (t) => {
  let truncate = true;
  const server = http.createServer((req, res) => {
    req.resume();
    if (truncate) {
      res.writeHead(200, { 'Content-Length': '9999', 'Content-Type': 'application/json' });
      res.write('{');
      setTimeout(() => res.destroy(), 10);
    } else res.end(JSON.stringify(kind === 'request' ? { jsonrpc: '2.0', id: 2, result: { ready: true } } : { ready: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const client = new LocalMcpClient({ port: server.address().port, token: 'fixture-only' });
  const call = () => kind === 'request' ? client.request('ping') : kind === 'health' ? client.healthStatus() : client.controlPost('/__control/test');
  let timer;
  t.after(() => clearTimeout(timer));
  await assert.rejects(Promise.race([call(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('reply remained pending')), 500); })]), /aborted|ECONNRESET/);
  clearTimeout(timer); truncate = false;
  assert.equal((await call()).ready, true);
});

test('a truncated Runtime identity response cannot stall the supervisor', async (t) => {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Length': '9999' }); res.write('{'); setTimeout(() => res.destroy(), 10); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  let timer; t.after(() => clearTimeout(timer));
  const result = await Promise.race([probeMcpIdentity(server.address().port, 'fixture-only'), new Promise(resolve => { timer = setTimeout(() => resolve('still pending'), 500); })]);
  assert.equal(result, null);
});
