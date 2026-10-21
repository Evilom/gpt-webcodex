const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatTabsController } = require('../electron/chatTabsController');

function fixture(t, confirm = async () => false) {
  const controllers = [], states = [];
  const tabs = new ChatTabsController({ confirm, onState: state => states.push(state), log: { warn() {} }, createController: options => {
    const controller = {
      options, loading: false, streamState: { status: 'healthy' }, login: {}, url: options.initialUrl, title: options.initialUrl,
      visible: false, disposed: false, loads: 0, sessionReady: Promise.resolve(),
      mount() {}, setContentInsets(value) { this.insets = value; }, setVisible(value) { this.visible = value; }, resize() {},
      activeContents() { return { focus() {} }; }, getState() { return { url: this.url, title: this.title, loading: this.loading, streamState: this.streamState }; },
      openUrl(url) { this.url = url; this.loads++; }, navigate(action) { this.action = action; },
      clearSession() { this.cleared = true; }, dispose() { this.disposed = true; }, cancelNativeLogin() {},
      emit(status, event) { this.streamState = { status, event }; options.onState(this.getState()); }
    };
    controllers.push(controller); return controller;
  } });
  t.after(() => tabs.dispose());
  tabs.mount();
  return { tabs, controllers, states };
}

test('tab switching preserves each controller and active state, sharing session initialization only once', t => {
  const { tabs, controllers } = fixture(t);
  const firstId = tabs.activeId, first = tabs.active;
  first.emit('generating', 'page-response-generating');
  tabs.openTab('https://chatgpt.com/c/second');
  const second = tabs.active, secondId = tabs.activeId;
  assert.notEqual(first, second); assert.equal(first.visible, false); assert.equal(first.disposed, false);
  first.emit('interrupted', 'page-message-stream-error');
  assert.equal(tabs.streamState.status, 'healthy');
  assert.equal(tabs.getState().tabs.find(tab => tab.id === firstId).unread, true);
  assert.equal(tabs.hasRunningWork(), true, 'hidden work blocks installing updates');
  tabs.selectTab(firstId);
  assert.equal(tabs.streamState.status, 'interrupted'); assert.equal(first.visible, true); assert.equal(second.visible, false);
  assert.equal(first.loads, 0); assert.equal(second.loads, 0);
  tabs.selectTab(secondId); first.options.onState(first.getState());
  assert.equal(tabs.getState().tabs.find(tab => tab.id === firstId).unread, false, 'an already-read error is not announced again by unrelated state updates');
  assert.equal(controllers[0].options.initializeSession, true); assert.equal(controllers[1].options.initializeSession, false);
  assert.equal(controllers[1].options.sessionReady, controllers[0].sessionReady);
  tabs.setContentInsets({ toolbarHeight: 94, right: 340 });
  assert.deepEqual(first.insets, second.insets);
});

test('protected navigation defaults to preserving the current page, then opens a separate tab only on confirmation', async t => {
  let allow = false, prompts = 0;
  const { tabs } = fixture(t, async kind => { assert.equal(kind, 'open'); prompts++; return allow; });
  const first = tabs.active, id = tabs.activeId;
  first.emit('generating');
  assert.equal(await tabs.requestNavigation(id, { url: 'https://chatgpt.com/c/other' }), false);
  assert.equal(tabs.tabs.size, 1); assert.equal(first.loads, 0);
  allow = true;
  await tabs.requestNavigation(id, { url: 'https://chatgpt.com/c/other' });
  assert.equal(tabs.tabs.size, 2); assert.equal(first.loads, 0); assert.equal(first.disposed, false); assert.equal(prompts, 2);
  await tabs.requestNavigation(tabs.activeId, { url: 'https://chatgpt.com/g/example/c/other?x=1', separate: true });
  assert.equal(tabs.tabs.size, 2, 'an existing conversation is focused, not opened twice');
});

test('DOM generation evidence protects navigation before the stream observer catches up', async t => {
  let prompted = false;
  const { tabs } = fixture(t, async () => { prompted = true; return false; });
  await tabs.requestNavigation(tabs.activeId, { url: 'https://chatgpt.com/c/other', generating: true });
  assert.equal(prompted, true); assert.equal(tabs.active.loads, 0);
});

test('a conversation still opening is deduplicated, but its old target is released after navigating elsewhere', t => {
  const { tabs } = fixture(t);
  tabs.openTab('https://chatgpt.com/c/pending');
  const pending = tabs.active, id = tabs.activeId; pending.url = '';
  tabs.openTab('https://chatgpt.com/c/pending');
  assert.equal(tabs.tabs.size, 2); assert.equal(tabs.activeId, id);
  pending.url = 'https://chatgpt.com/'; pending.options.onState(pending.getState());
  tabs.openTab('https://chatgpt.com/c/pending'); assert.equal(tabs.tabs.size, 3);
});

test('closing an active stream requires confirmation and only disposes the requested tab', async t => {
  let allow = false;
  const { tabs } = fixture(t, async () => allow);
  const id = tabs.activeId, first = tabs.active;
  first.emit('generating'); tabs.openTab(); const second = tabs.active;
  assert.equal(await tabs.closeTab(id), false); assert.equal(first.disposed, false);
  allow = true; await tabs.closeTab(id);
  assert.equal(first.disposed, true); assert.equal(second.disposed, false); assert.equal(tabs.active, second);
  const before = tabs.getState(); first.emit('interrupted'); assert.deepEqual(tabs.getState(), before);
  await tabs.closeTab(tabs.activeId); assert.equal(tabs.tabs.size, 1, 'closing the last idle tab leaves a usable new conversation');
});

test('pending prompts and old hidden requests cannot overwrite another page', async t => {
  let answer;
  const { tabs } = fixture(t, () => new Promise(resolve => { answer = resolve; }));
  const id = tabs.activeId; tabs.active.emit('generating');
  const pending = tabs.requestNavigation(id, { url: 'https://chatgpt.com/c/target' });
  assert.equal(await tabs.requestNavigation(id, { url: 'https://chatgpt.com/c/duplicate' }), false);
  answer(false); await pending;
  tabs.active.emit('healthy'); tabs.openTab();
  assert.equal(await tabs.requestNavigation(id, { url: 'https://chatgpt.com/c/old' }), false);
  assert.equal(await tabs.requestNavigation(tabs.activeId, { url: 'https://evil.test/c/outside' }), false);
});

test('tab cap preserves existing work and keyboard switching never reloads a tab', t => {
  const { tabs, controllers } = fixture(t);
  while (tabs.tabs.size < 8) tabs.openTab();
  assert.throws(() => tabs.openTab(), /8/); assert.ok(controllers.every(controller => !controller.disposed));
  const id = tabs.activeId;
  assert.equal(tabs.handleShortcut({ type: 'keyDown', control: true, key: 'Tab' }), true);
  assert.notEqual(tabs.activeId, id);
  assert.equal(tabs.handleShortcut({ type: 'keyDown', control: true, key: 'Tab', shift: true }), true);
  assert.equal(tabs.activeId, id); assert.ok(controllers.every(controller => !controller.loads));
});

test('shared login cleanup is blocked by hidden generation and removes stale idle pages after cleanup', async t => {
  const { tabs } = fixture(t);
  const first = tabs.active; first.emit('generating'); tabs.openTab();
  assert.equal((await tabs.cancelNativeLogin()).tabs.length, 2, 'login actions return the complete tab state to the shell');
  await assert.rejects(() => tabs.clearSession(), /标签/);
  await assert.rejects(() => tabs.startNativeLogin(), /其他标签/);
  first.emit('healthy'); await tabs.clearSession();
  assert.equal(tabs.tabs.size, 1); assert.equal(first.disposed, true); assert.equal(tabs.active.cleared, true);
});

test('an idle page with an enabled goal still protects update and shared-session cleanup', async t => {
  const { tabs } = fixture(t);
  tabs.options.getGoalState = () => ({ status: 'running' });
  assert.equal(tabs.hasRunningWork(), true);
  await assert.rejects(() => tabs.clearSession(), /标签/);
  tabs.options.getGoalState = () => ({ status: 'paused' });
  assert.equal(tabs.hasRunningWork(), false);
});
