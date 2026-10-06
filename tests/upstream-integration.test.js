const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ChatViewController } = require('../electron/chatViewController');

test('integrated desktop registers every IPC channel once', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
  const registration = source.slice(source.indexOf('function registerIpc()'), source.indexOf('const hasSingleInstanceLock'));
  const channels = new Set();
  vm.runInNewContext(`${registration}\nregisterIpc();`, {
    secureHandle(channel) {
      assert.ok(!channels.has(channel), `duplicate IPC channel: ${channel}`);
      channels.add(channel);
    }
  });
  for (const channel of ['checkpoint:rollback', 'git:commit-and-push', 'task:write-handoff', 'workspace:inspect', 'chat:native-login-start']) {
    assert.ok(channels.has(channel), channel);
  }
});

test('local drawer insets preserve the upstream chat boundary and avoid repeated resize', () => {
  const bounds = [];
  const controller = new ChatViewController({
    window: { isDestroyed: () => false, getContentSize: () => [1360, 900] },
    toolbarHeight: 164
  });
  controller.view = { setBounds: (value) => bounds.push(value) };
  controller.setContentInsets({ bottom: 320 });
  assert.deepEqual(bounds[0], { x: 0, y: 164, width: 1360, height: 416 });
  controller.setContentInsets({ bottom: 320 });
  assert.equal(bounds.length, 1);
  controller.setContentInsets({ bottom: 0 });
  assert.deepEqual(bounds[1], { x: 0, y: 164, width: 1360, height: 736 });
});

test('changing Windows startup preserves the active user data directory', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
  const registration = source.slice(source.indexOf('function registerIpc()'), source.indexOf('const hasSingleInstanceLock'));
  const handlers = new Map();
  const calls = [];
  const profile = 'C:\\Users\\Fixture\\.web-mcp-assistant';
  const executable = 'C:\\Apps\\web-mcp-assistant\\assistant.exe';
  let current = { startWithWindows: false };
  vm.runInNewContext(`${registration}\nregisterIpc();`, {
    secureHandle: (channel, handler) => handlers.set(channel, handler),
    invokeSafely: (action) => action(),
    settings: { load: () => current, save: (patch) => (current = { ...current, ...patch }) },
    app: { getPath: () => profile, setLoginItemSettings: (options) => calls.push(options) },
    process: { execPath: executable },
    clearProxyCache() {},
    chatController: null
  });
  for (const enabled of [true, false]) {
    await handlers.get('settings:save')(null, { startWithWindows: enabled });
    const call = calls.at(-1);
    assert.equal(call.openAtLogin, enabled);
    assert.equal(call.path, executable);
    assert.equal(call.args?.[0], `--user-data-dir=${profile}`);
  }
  const startupCall = source.slice(source.indexOf('app.whenReady()')).match(/app\.setLoginItemSettings\(\{[^;]*\}\);/)[0];
  vm.runInNewContext(startupCall, {
    app: { getPath: () => profile, setLoginItemSettings: (options) => calls.push(options) },
    process: { execPath: executable },
    settings: { load: () => current }
  });
  assert.equal(calls.at(-1).args?.[0], `--user-data-dir=${profile}`);
});
