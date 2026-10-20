const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { UpdateService, isNewerVersion } = require('../electron/services/updateService');
const { ChatTabsController } = require('../electron/chatTabsController');

function fixture(options = {}) {
  const updater = new EventEmitter(), states = [];
  Object.assign(updater, { setFeedURL: (value) => { updater.feed = value; }, checkForUpdates: async () => updater.emit('update-not-available'), downloadUpdate: async () => updater.emit('update-downloaded', { version: '0.9.7' }), quitAndInstall: (...args) => { updater.installArgs = args; } });
  const service = new UpdateService({ updater, version: '0.9.6', packaged: true, platform: 'win32', log: { warn() {} }, onState: (value) => states.push(value), ...options });
  return { service, updater, states };
}

test('updates use only our repository, never install or download automatically', () => {
  const f = fixture();
  assert.deepEqual(f.updater.feed, { provider: 'github', owner: 'Evilom', repo: 'gpt-webcodex', private: false });
  assert.equal(f.updater.autoDownload, false); assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.allowDowngrade, false); assert.equal(f.updater.allowPrerelease, false);
  assert.throws(() => f.service.install(), /尚未/);
});

test('version comparison ignores prereleases and never downgrades', () => {
  assert.equal(isNewerVersion('0.9.10', '0.9.6'), true);
  for (const version of ['0.9.6', '0.9.5', '0.9.7-beta', 'invalid']) assert.equal(isNewerVersion(version, '0.9.6'), false);
});

test('simultaneous checks share one request, then explicit download and install progress', async () => {
  const f = fixture(); let checks = 0;
  f.updater.checkForUpdates = async () => { checks++; f.updater.emit('update-available', { version: '0.9.7' }); };
  await Promise.all([f.service.check(), f.service.check()]);
  assert.equal(checks, 1); assert.equal(f.service.getState().stage, 'available');
  await f.service.download(); assert.equal(f.service.getState().stage, 'downloaded');
  await f.service.check(); assert.equal(checks, 1);
  f.service.install(); assert.deepEqual(f.updater.installArgs, [false, true]);
});

test('network failure remains retryable without blocking startup', async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => { throw new Error('offline'); };
  assert.equal((await f.service.check()).stage, 'error');
  f.updater.checkForUpdates = async () => f.updater.emit('update-not-available');
  assert.equal((await f.service.check()).stage, 'current');
});

test('GitHub fetch failures are readable while HTTP and integrity diagnostics stay specific', async () => {
  const logged = [];
  const f = fixture({ log: { warn: (_message, detail) => logged.push(detail.error) } });
  f.updater.checkForUpdates = async () => { throw new TypeError('fetch failed'); };
  const state = await f.service.check();
  assert.match(state.error, /GitHub.*网络或代理/);
  assert.deepEqual(logged, ['fetch failed']);
  for (const error of [new Error('fetch failed'), new Error('GitHub 返回 403'), new Error('sha512 mismatch'), new TypeError('Invalid URL')]) {
    f.service.failed(error);
    assert.equal(f.service.getState().error, error.message);
  }
  f.updater.checkForUpdates = async () => f.updater.emit('update-not-available');
  assert.equal((await f.service.check()).stage, 'current');
});

test('Mac and source checkouts check our release but require a manual install', async () => {
  let opened;
  const f = fixture({ platform: 'darwin', fetch: async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/Evilom/gpt-webcodex/releases/latest'); assert.ok(options.signal);
    return { ok: true, json: async () => ({ tag_name: 'v0.9.7' }) };
  }, openExternal: async (url) => { opened = url; } });
  assert.equal((await f.service.check()).stage, 'available');
  await f.service.download(); assert.equal(opened, 'https://github.com/Evilom/gpt-webcodex/releases/latest');
  assert.throws(() => f.service.install(), /尚未/);
});

test('unpublished releases are distinct from a network failure', async () => {
  const f = fixture({ packaged: false, fetch: async () => ({ status: 404 }) });
  assert.equal((await f.service.check()).stage, 'unpublished');
});

test('API rate limits fall back only to our public release page', async () => {
  let calls = 0;
  const f = fixture({ platform: 'darwin', fetch: async () => ++calls === 1 ? { status: 429 } : { ok: true, url: 'https://github.com/Evilom/gpt-webcodex/releases/tag/v0.9.7' } });
  assert.equal((await f.service.check()).latest, '0.9.7');
  const bad = fixture({ platform: 'darwin', fetch: async (url) => url.includes('api.github') ? { status: 403 } : { ok: true, url: 'https://github.com/other/project/releases/tag/v99.0.0' } });
  assert.equal((await bad.service.check()).stage, 'error');
});

test('periodic checks start after the UI and stop on quit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(); let calls = 0; f.service.check = () => { calls++; };
  f.service.start(); assert.equal(calls, 0);
  t.mock.timers.tick(15000); assert.equal(calls, 1);
  t.mock.timers.tick(6 * 60 * 60 * 1000); assert.equal(calls, 2);
  f.service.stop(); t.mock.timers.tick(6 * 60 * 60 * 1000); assert.equal(calls, 2);
});

test('installation IPC refuses an active answer, task, command or service transition', async () => {
  const source = fs.readFileSync('electron/main.js', 'utf8');
  const registration = source.slice(source.indexOf('function registerIpc()'), source.indexOf('const hasSingleInstanceLock'));
  for (const scenario of ['answer', 'background-answer', 'background-recovery', 'background-loading', 'login', 'task', 'waiting', 'command', 'transition', 'idle']) {
    const handlers = new Map(), scheduled = [];
    const chatController = new ChatTabsController({});
    chatController.tabs.set('active', { controller: { streamState: { status: scenario === 'answer' ? 'generating' : 'healthy' }, nativeLogin: { run: scenario === 'login' } } });
    chatController.tabs.set('background', { controller: { streamState: { status: scenario === 'background-answer' ? 'generating' : scenario === 'background-recovery' ? 'interrupted' : 'healthy' }, loading: scenario === 'background-loading' } });
    chatController.activeId = 'active';
    vm.runInNewContext(`${registration}\nregisterIpc();`, {
      secureHandle: (name, handler) => handlers.set(name, handler), invokeSafely: (action) => action(),
      chatController,
      orchestrator: { busy: scenario === 'transition', native: { status: async () => true } },
      settings: { load: () => ({ workspace: 'fixture', mcpPort: 18765 }) }, secrets: { get: () => 'synthetic-test-only' },
      workspaceStatePaths: () => ({ statePath: 'fixture.json' }), readJson: () => ({ status: scenario === 'task' ? 'running' : scenario === 'waiting' ? 'waiting' : 'completed' }),
      LocalMcpClient: class { async healthStatus() { return { active_commands: scenario === 'command' ? 1 : 0 }; } },
      updateService: { getState: () => ({ stage: 'downloaded' }) }, log: {}, setImmediate: (callback) => scheduled.push(callback)
    });
    if (scenario === 'idle') { assert.equal((await handlers.get('update:install')()).installing, true); assert.equal(scheduled.length, 1); }
    else { await assert.rejects(handlers.get('update:install')()); assert.equal(scheduled.length, 0); }
  }
});
