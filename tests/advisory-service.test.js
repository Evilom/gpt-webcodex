const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AdvisoryService } = require('../electron/services/advisoryService');
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
    return { ok: true, json: async () => url.endsWith('/models') ? { models: [{ id: 'anthropic::claude-opus-5-5' }] } : { id: 'job_fixture_123', status: options.method === 'POST' ? 'queued' : 'completed', responses: [] } };
  });
  await service.catalog();
  service.select(['anthropic::claude-opus-5-5']);
  await service.submit('分析这份设计，不执行命令');
  await assert.rejects(service.submit('重复请求'), /已有辅助咨询/);
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
    throw new Error('timeout');
  });
  await service.catalog();
  service.select(['anthropic::claude-opus-5-5']);
  await assert.rejects(service.submit('独立咨询'), /timeout/);
  assert.match(service.status().job.request_id, /^[\w-]+$/);
  await assert.rejects(service.submit('重放'), /已有辅助咨询/);
});
test('remote insecure URLs and credential forwarding redirects are refused', (t) => {
  const { service } = setup(t, async () => {});
  assert.throws(() => service.validateBase('http://remote.example'), /HTTPS/);
  assert.throws(() => service.validateBase('https://user:pass@remote.example'), /HTTPS/);
  assert.equal(service.validateBase('http://127.0.0.1:8085'), 'http://127.0.0.1:8085');
});
