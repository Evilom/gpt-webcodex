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
