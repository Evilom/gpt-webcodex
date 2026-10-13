const test = require('node:test');
const assert = require('node:assert/strict');
const { AdvisoryBridge } = require('../electron/services/advisoryBridge');

test('AI bridge authenticates MCP, confines calls to loopback, and never returns the upstream key', async (t) => {
  const calls = [];
  const bridge = new AdvisoryBridge({ port: 0, secrets: { get: () => 'fixture-mcp-token' }, service: {
    agentCall: async (args) => { calls.push(args); return { selected: ['anthropic::claude-opus-5-5'], configured: true }; }, status: () => ({ job: null })
  } });
  const url = await bridge.start(); t.after(() => bridge.stop());
  const denied = await fetch(url, { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401); assert.equal(calls.length, 0);
  const headers = { Authorization: 'Bearer fixture-mcp-token', 'Content-Type': 'application/json' };
  const origin = await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://chatgpt.com' }, body: '{}' });
  assert.equal(origin.status, 403);
  const good = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ action: 'status' }) });
  assert.equal(good.status, 200); assert.equal((await good.json()).configured, true);
  const oversized = await fetch(url, { method: 'POST', headers, body: 'a'.repeat(65537) });
  assert.equal(oversized.status, 413); assert.equal(calls.length, 1);
});
