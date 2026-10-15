const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { ChatViewController, bindChatNetworkDiagnostics } = require('../electron/chatViewController');
const { finishShutdown } = require('../electron/services/shutdownService');

function fixture(t, url = 'https://chatgpt.com/') {
  const contents = new EventEmitter();
  const states = [], closes = [], loads = [];
  Object.assign(contents, { url, dead: false, getURL() { return this.url; }, getTitle: () => '', isDestroyed() { return this.dead; },
    canGoBack: () => false, canGoForward: () => false, setWindowOpenHandler() {}, executeJavaScript: async () => null,
    close(options) { closes.push(options); this.dead = true; }, loadURL: async (next) => loads.push(next), stop() {}, isLoadingMainFrame: () => true });
  const window = { isDestroyed: () => false, removeListener() {}, contentView: { removeChildView() {} } };
  const controller = new ChatViewController({ window, log: { info() {}, warn() {}, error() {} }, settings: { load: () => ({}) }, onState: (state) => states.push(state) });
  controller.view = { webContents: contents, setVisible() {} };
  controller.bindWebContents();
  t.after(() => controller.dispose());
  return { controller, contents, states, closes, loads };
}

test('stream state rejects stale documents, other conversations and child-frame reports', (t) => {
  const f = fixture(t, 'https://chatgpt.com/c/first');
  f.contents.id = 42;
  f.contents.mainFrame = {};
  const report = (documentId, conversationId, frame=f.contents.mainFrame) => f.contents.emit('console-message', {
    frame, message:'[web-mcp-stream] '+JSON.stringify({document_id:documentId,conversation_id:conversationId,status:'generating',event:'page-response-generating',activity_at:1000,quiet_seconds:0,stalled:false})
  });
  report(0, 'first');
  assert.equal(f.controller.streamState.status,'generating');
  f.contents.url='https://chatgpt.com/g/project/c/second';
  f.contents.emit('did-navigate-in-page', {}, f.contents.url, true);
  assert.equal(f.controller.streamState.status,'unknown');
  assert.equal(f.controller.streamState.activityAt,0);
  report(0,'first');
  report(1,'first');
  report(1,'second',{});
  assert.equal(f.controller.streamState.status,'unknown');
  report(1,'second');
  assert.equal(f.controller.streamState.status,'generating');
  assert.equal(f.controller.streamState.webContentsId,42);
  assert.equal(f.controller.streamState.conversationId,'second');
  f.contents.emit('did-navigate-in-page', {}, 'https://chatgpt.com/c/child', false);
  assert.equal(f.controller.streamState.status,'generating');
  assert.equal(f.controller.streamDocumentRevision,1);
});

test('dispose is idempotent, skips beforeunload and detaches late renderer events', async (t) => {
  const f = fixture(t);
  f.controller.nativeLogin = { cancel: async () => { throw new Error('cleanup failed'); } };
  f.controller.dispose(); f.controller.dispose();
  assert.deepEqual(f.closes, [{ waitForBeforeUnload: false }]);
  assert.equal(f.contents.listenerCount('did-start-loading'), 0);
  f.contents.emit('unresponsive'); f.controller.emitState();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.states.length, 0);
});

test('network retry stops after five attempts and never replays a concrete chat or OAuth code', (t) => {
  const f = fixture(t);
  assert.equal(f.controller.scheduleTransientRetry('https://chatgpt.com/c/active', 'ERR_CONNECTION_RESET'), false);
  assert.equal(f.controller.scheduleTransientRetry('https://chatgpt.com/api/auth/callback/google?code=test', 'ERR_CONNECTION_RESET'), false);
  f.controller.retryAttempt = 5;
  assert.equal(f.controller.scheduleTransientRetry('https://chatgpt.com/', 'ERR_CONNECTION_RESET'), false);
  assert.equal(f.controller.retryTimer, null);
  assert.match(f.controller.lastError, /多次失败/);
});

test('a pending retry cannot navigate away from a chat the user opened meanwhile', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  f.controller.scheduleTransientRetry('https://chatgpt.com/', 'ERR_CONNECTION_RESET');
  f.contents.url = 'https://chatgpt.com/c/current';
  t.mock.timers.tick(1500);
  assert.deepEqual(f.loads, []);
});

test('main-frame deadline leaves conversation recovery to the user and is cancelled on dispose', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, 'https://chatgpt.com/c/current');
  f.controller.armLoadDeadline(f.contents, 10);
  t.mock.timers.tick(10);
  assert.match(f.controller.lastError, /超过 60 秒/);
  assert.equal(f.controller.retryTimer, null);
  f.controller.armLoadDeadline(f.contents, 10);
  f.controller.dispose();
  t.mock.timers.tick(10);
  assert.deepEqual(f.loads, []);
});

test('1000 streaming mutations create one capability scan, without rereading armed history', (t) => {
  const f = fixture(t);
  let script, callback, reads = 0;
  const timers = [], reports = [], stored = new Map();
  f.contents.executeJavaScript = (source) => { script = source; return Promise.resolve(); };
  f.controller.scheduleContinuousMcpMode();
  const users = Array.from({ length: 500 }, (_, i) => ({ closest() { return this; }, get textContent() { reads++; return i === 499 ? 'Coding Tools MCP' : 'old turn'; } }));
  const main = { get innerText() { throw new Error('full transcript layout scan'); } };
  vm.runInNewContext(script, { window: {}, location: { pathname: '/c/long-chat' }, Element: class {},
    document: { querySelector: (selector) => selector === 'main' ? main : null, querySelectorAll: (selector) => selector.includes('data-message-author-role') ? users : [],
      removeEventListener() {}, addEventListener() {} },
    sessionStorage: { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    MutationObserver: class { constructor(fn) { callback = fn; } observe() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {}, console: { info: (line) => reports.push(line) }
  });
  assert.equal(reads, 500);
  const firstReports = reports.length;
  for (let i = 0; i < 1000; i++) callback();
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.equal(reads, 500);
  assert.equal(reports.length, firstReports);
});

test('quit exits after successful, failing and stuck cleanup without propagating failures', async () => {
  for (const task of [async () => {}, async () => { throw new Error('failed'); }, () => new Promise(() => {})]) {
    let exits = 0;
    await finishShutdown({ tasks: [task], log: { warn() {} }, timeoutMs: 15, exit: () => { exits++; } });
    assert.equal(exits, 1);
  }
});

test('network diagnostics cover CDN and HTTP failures without secrets or duplicate noise', () => {
  const logs = []; let failure, complete, urls;
  bindChatNetworkDiagnostics({ webRequest: {
    onErrorOccurred: (filter, callback) => { urls = filter.urls; failure = callback; },
    onCompleted: (_filter, callback) => { complete = callback; }
  } }, { warn: (_message, details) => logs.push(details) });
  assert.ok(urls.includes('https://*.oaistatic.com/*'));
  const details = { url: 'https://chatgpt.com/backend-api/conversation/private-id?token=synthetic', resourceType: 'xhr', error: 'net::ERR_CONNECTION_RESET' };
  failure(details); failure(details);
  failure({ ...details, error: 'net::ERR_ABORTED' });
  complete({ ...details, error: '', statusCode: 429 });
  complete({ ...details, error: '', statusCode: 200 });
  assert.equal(logs.length, 2); assert.equal(logs[1].statusCode, 429);
  assert.equal(logs[0].route, '/backend-api/conversation');
  assert.doesNotMatch(JSON.stringify(logs), /private-id|synthetic|token/);
});

test('stream observer recognizes visible recovery status in current Chinese and English UI', async (t) => {
  for (const [text, visible, expected] of [
    ['连接已中断，正在等待完整答复', true, 'interrupted'],
    ['连接已中断。正在等待完整回复', true, 'interrupted'],
    ['Connection interrupted. Waiting for the complete response', true, 'interrupted'],
    ['连接已中断，正在等待完整答复', false, 'healthy'],
    ['正在思考', true, 'healthy']
  ]) {
    const f = fixture(t, 'https://chatgpt.com/c/current');
    let script;
    const timers = [], reports = [];
    const notice = { textContent: text, getBoundingClientRect: () => ({ width: visible ? 100 : 0, height: visible ? 20 : 0 }) };
    f.contents.executeJavaScript = (source) => { script = source; return Promise.resolve(); };
    f.controller.scheduleStreamObserver();
    const window = {};
    vm.runInNewContext(script, {
      window,
      document: {
        querySelector: () => ({}),
        querySelectorAll: (selector) => selector.includes('[role="status"]') ? [notice] : []
      },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      MutationObserver: class { observe() {} },
      setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
      console: { info: (line) => reports.push(JSON.parse(line.slice('[web-mcp-stream] '.length))) }
    });
    timers.shift()();
    assert.equal(window.__mcpStreamStatus, expected, text);
    if (expected === 'interrupted') assert.equal(reports.at(-1)?.event, 'page-stream-interrupted');
    assert.deepEqual(f.loads, []);
  }
});
