const test = require('node:test');
const assert = require('node:assert/strict');
const { describe } = require('../renderer/shellPresentation');
const { ChatViewController } = require('../electron/chatViewController');

test('page interruption leaves healthy runtime and upstream states visible', () => {
  const view = describe({ url: 'https://chatgpt.com/c/test' }, { mcpRunning: true, tunnelRunning: true, connectionRunning: true }, { status: 'interrupted' });
  assert.equal(view.incident.layer, 'page');
  assert.equal(view.incident.canRecover, true);
  assert.equal(view.mcp.label, '正常');
  assert.equal(view.tunnel.label, '正常');
});
test('a live tunnel PID does not imply upstream reachability', () => {
  const view = describe({ url: 'https://chatgpt.com' }, { mcpRunning: true, tunnelRunning: true, connectionRunning: false });
  assert.equal(view.tunnel.label, '上游不可达');
  assert.equal(view.incident.layer, 'tunnel');
  assert.equal(view.incident.canRecover, false);
});
test('missing status is unknown rather than a claim that a service stopped', () => {
  const view = describe({ url: 'https://chatgpt.com' }, null);
  assert.equal(view.mcp.label, '等待确认');
  assert.equal(view.tunnel.label, '等待确认');
  assert.equal(view.incident, null);
});
test('navigation, workbench, alerts and console reserve native chat space and closing restores it', () => {
  const bounds = [];
  const controller = new ChatViewController({ window: { isDestroyed: () => false, getContentSize: () => [1440, 1024] }, toolbarHeight: 56 });
  controller.view = { webContents: { isDestroyed: () => false }, setBounds: (value) => bounds.push(value) };
  controller.setContentInsets({ toolbarHeight: 108, left: 240, right: 340, bottom: 36 });
  assert.deepEqual(bounds.at(-1), { x: 240, y: 108, width: 860, height: 880 });
  controller.setContentInsets({ toolbarHeight: 108, left: 240, right: 340, bottom: 336 });
  assert.equal(bounds.at(-1).height, 580);
  controller.setContentInsets({ toolbarHeight: 56, left: 420, right: 560, bottom: 32 });
  assert.deepEqual(bounds.at(-1), { x: 420, y: 56, width: 460, height: 936 });
  controller.setContentInsets({ toolbarHeight: 56, right: 0, bottom: 36 });
  assert.deepEqual(bounds.at(-1), { x: 0, y: 56, width: 1440, height: 932 });
  const count = bounds.length;
  controller.setContentInsets({ toolbarHeight: 56, right: 0, bottom: 36 });
  assert.equal(bounds.length, count);
});
test('embedded authentication follows both sidebars while staying below the login toolbar', () => {
  let chatBounds, authBounds;
  const controller = new ChatViewController({ window: { isDestroyed: () => false, getContentSize: () => [1440, 1024] }, toolbarHeight: 56 });
  controller.view = { webContents: { isDestroyed: () => false }, setBounds: (value) => { chatBounds = value; } };
  controller.authViews = [{ webContents: { isDestroyed: () => false }, setBounds: (value) => { authBounds = value; } }];
  controller.setContentInsets({ toolbarHeight: 56, top: 80, left: 240, right: 340, bottom: 32 });
  assert.deepEqual(chatBounds, { x: 240, y: 136, width: 860, height: 856 });
  assert.deepEqual(authBounds, { x: 240, y: 56, width: 860, height: 936 });
  controller.setContentInsets({ toolbarHeight: 56, bottom: 32 });
  assert.deepEqual(authBounds, { x: 0, y: 56, width: 1440, height: 936 });
});
test('native chat bounds stay nonnegative in a small viewport', () => {
  let bounds;
  const controller = new ChatViewController({ window: { isDestroyed: () => false, getContentSize: () => [400, 200] }, toolbarHeight: 56 });
  controller.view = { webContents: { isDestroyed: () => false }, setBounds: (value) => { bounds = value; } };
  controller.setContentInsets({ toolbarHeight: 108, top: 1000, left: 240, right: 300, bottom: 900 });
  assert.deepEqual(bounds, { x: 160, y: 200, width: 240, height: 0 });
});
