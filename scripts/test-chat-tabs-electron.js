'use strict';
const { app, BrowserWindow, session, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const archiveIndex = process.argv.indexOf('--archive');
const productionRoot = archiveIndex >= 0 ? path.resolve(process.argv[archiveIndex + 1]) : root;
const { ChatViewController } = require(path.join(productionRoot, 'electron/chatViewController'));
const { ChatTabsController } = require(path.join(productionRoot, 'electron/chatTabsController'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'thinktank-tabs-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const output = path.join(root, 'build/chat-tabs-smoke.json');
const report = { ok: false };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const clients = new Map(), connections = new Map(), tokens = new Map();
let server, window, tabs, confirmResult = false, prompts = 0, downloads = 0, proxyChanges = 0;
const watchdog = setTimeout(() => fail(new Error('多标签隔离验证超时')), 60000);
async function until(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(30); }
  throw new Error('等待多标签验证条件超时');
}
function fail(error) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ ...report, error: error.message, stack: error.stack }, null, 2));
  console.error(error); app.exit(1);
}
function fixturePage(id) {
  return `<!doctype html><html><head><title>并行对话 ${id}</title></head><body><main><section data-testid="conversation-turn-1"><div data-message-author-role="assistant" id="answer"></div></section><button id="stop" data-testid="stop-button" aria-label="停止生成">停止</button></main><div id="prompt-textarea" contenteditable="true" role="textbox"></div><input type="file" id="upload"><a id="other" href="https://chatgpt.com/c/b">另一个对话</a><script>
    window.fixtureId=${JSON.stringify(id)};window.ticks=0;window.navClicks=0;
    const source=new EventSource('/stream?id='+window.fixtureId);
    source.onmessage=event=>{if(event.data==='DONE'){source.close();document.getElementById('stop')?.remove();return;}document.getElementById('answer').textContent+=event.data+' ';window.ticks++;};
    document.getElementById('stop').onclick=()=>{source.close();document.getElementById('stop').remove();};
    document.getElementById('other').onclick=event=>{event.preventDefault();window.navClicks++;history.pushState({},'',event.currentTarget.href);};
  </script></body></html>`;
}
app.whenReady().then(async () => {
  const files = path.join(profile, 'downloads'); fs.mkdirSync(files);
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/stream') {
      const id = url.searchParams.get('id'); connections.set(id, (connections.get(id) || 0) + 1);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.write(': connected\n\n'); clients.set(id, response);
      const interval = setInterval(() => { const next = (tokens.get(id) || 0) + 1; tokens.set(id, next); response.write(`data: ${id}-${next}\n\n`); }, 45);
      response.on('close', () => { clearInterval(interval); clients.delete(id); }); return;
    }
    if (url.pathname === '/backend-api/files/download/tabs-proof') {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="tabs-proof.txt"' });
      response.end('parallel tab download proof\n'); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(fixturePage(url.pathname.split('/').at(-1) || 'home'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chatSession = session.fromPartition('persist:chatgpt-session');
  // Secure ChatGPT origins are served by our real local streaming transport in
  // an isolated profile. No production login, conversation or model is touched.
  await chatSession.protocol.handle('https', request => { const url = new URL(request.url); return fetch(origin + url.pathname + url.search); });
  window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { preload: path.join(productionRoot, 'electron/browserPreload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  tabs = new ChatTabsController({ window, settings: { load: () => ({ workspace: files, proxyMode: 'direct', continuousMcpMode: false }) },
    log: { info() {}, warn() {}, error() {} }, toolbarHeight: 94,
    confirm: async () => { prompts++; return confirmResult; },
    onState: state => { if (!window.isDestroyed()) window.webContents.send('chat:state', state); },
    onDownload: state => { if (state.status === 'completed') downloads++; },
    createController: options => {
      const controller = new ChatViewController(options);
      controller.probeLogin = async () => true;
      controller.refreshBrowserNetworkDiagnostics = async () => ({});
      const apply = controller.applyBrowserProxyPolicy.bind(controller);
      controller.applyBrowserProxyPolicy = async (...args) => { proxyChanges++; return apply(...args); };
      return controller;
    }
  });
  for (const [channel, callback] of Object.entries({
    'chat:status': () => tabs.getState(), 'chat:tab-open': () => tabs.openTab(),
    'chat:tab-select': (_event, id) => tabs.selectTab(id), 'chat:tab-close': (_event, id) => tabs.closeTab(id),
    'chat:set-content-insets': (_event, value) => tabs.setContentInsets(value)
  })) ipcMain.handle(channel, async (...args) => ({ ok: true, data: await callback(...args) }));
  await window.loadFile(path.join(__dirname, 'fixtures/chat-tabs-shell.html'));
  tabs.openTab('https://chatgpt.com/c/a');
  const firstId = tabs.activeId, first = tabs.active, a = first.view.webContents;
  await until(() => first.streamState.status === 'generating');
  const headerHeight = await window.webContents.executeJavaScript(`document.querySelector('.browser-toolbar').getBoundingClientRect().height`);
  assert.ok(headerHeight >= 94 && headerHeight <= 100); assert.equal(first.view.getBounds().y, headerHeight);
  await a.executeJavaScript(`document.getElementById('prompt-textarea').textContent='保留第一份草稿';const transfer=new DataTransfer();transfer.items.add(new File(['proof'],'proof.txt',{type:'text/plain'}));document.getElementById('upload').files=transfer.files;true;`);
  await a.executeJavaScript(`document.getElementById('other').click();true;`);
  await until(() => prompts === 1); assert.equal(tabs.tabs.size, 1); assert.equal(a.getURL(), 'https://chatgpt.com/c/a');
  assert.equal(await a.executeJavaScript('window.navClicks'), 0, 'capture blocks native SPA replacement');
  confirmResult = true;
  await a.executeJavaScript(`document.getElementById('other').click();true;`);
  await until(() => tabs.tabs.size === 2 && tabs.active.streamState.status === 'generating');
  const secondId = tabs.activeId, second = tabs.active, b = second.view.webContents;
  const before = [await a.executeJavaScript('window.ticks'), await b.executeJavaScript('window.ticks')];
  await b.executeJavaScript(`document.getElementById('prompt-textarea').textContent='保留第二份草稿';true;`);
  const started = performance.now();
  for (let index = 0; index < 60; index++) tabs.selectTab(index % 2 ? secondId : firstId);
  report.switch60Ms = Math.round(performance.now() - started);
  await until(async () => await a.executeJavaScript('window.ticks') > before[0] + 4 && await b.executeJavaScript('window.ticks') > before[1] + 4);
  assert.equal(await a.executeJavaScript(`document.getElementById('prompt-textarea').textContent`), '保留第一份草稿');
  assert.equal(await b.executeJavaScript(`document.getElementById('prompt-textarea').textContent`), '保留第二份草稿');
  assert.equal(await a.executeJavaScript(`document.getElementById('upload').files[0].name`), 'proof.txt');
  assert.equal(a.getURL(), 'https://chatgpt.com/c/a'); assert.equal(b.getURL(), 'https://chatgpt.com/c/b');
  assert.notEqual(a.id, b.id); assert.equal(proxyChanges, 1); assert.equal(chatSession.listenerCount('will-download'), 1);
  assert.equal(connections.get('a'), 1); assert.equal(connections.get('b'), 1);
  // A real attachment download from a hidden tab is handled exactly once.
  a.downloadURL('https://chatgpt.com/backend-api/files/download/tabs-proof');
  await until(() => downloads === 1);
  assert.equal(fs.readFileSync(path.join(files, 'tabs-proof.txt'), 'utf8'), 'parallel tab download proof\n');
  await a.executeJavaScript(`document.getElementById('answer').insertAdjacentHTML('afterend','<div role="status" class="text-token-text-error">消息流中的错误</div>');true;`);
  await until(() => first.streamState.status === 'interrupted');
  assert.equal(tabs.getState().streamState.status, 'generating', 'background error cannot overwrite the active stream');
  assert.equal(tabs.getState().tabs.find(tab => tab.id === firstId).unread, true);
  assert.equal(tabs.hasRunningWork(), true);
  // Use the actual renderer tab button -> preload -> IPC -> coordinator.
  await until(async () => await window.webContents.executeJavaScript(`document.querySelectorAll('[role="tab"]').length===2`));
  await window.webContents.executeJavaScript(`document.querySelector('[role="tab"]').click();true;`);
  await until(() => tabs.activeId === firstId);
  assert.equal(tabs.streamState.status, 'interrupted');
  await tabs.requestNavigation(firstId, { url: 'https://chatgpt.com/g/example/c/b?view=full', separate: true });
  assert.equal(tabs.tabs.size, 2); assert.equal(tabs.activeId, secondId);
  confirmResult = false; await tabs.closeTab(firstId); assert.equal(a.isDestroyed(), false);
  assert.equal(await tabs.stopGeneration(), true);
  await until(() => second.streamState.status === 'healthy');
  assert.equal(first.streamState.status, 'interrupted');
  confirmResult = true; await tabs.closeTab(firstId); await until(() => a.isDestroyed()); assert.equal(b.isDestroyed(), false);
  const beforeClose = second.streamState.status;
  a.emit('console-message', {}, 1, '[web-mcp-stream] '+JSON.stringify({ status: 'generating', event: 'late-closed-tab', document_id: first.streamDocumentRevision, conversation_id: 'a' }));
  assert.equal(second.streamState.status, beforeClose);
  report.ok = true; Object.assign(report, { packaged: archiveIndex >= 0, parallelWebContents: true, streamConnections: Object.fromEntries(connections), preservedDrafts: 2, preservedUpload: true, downloadCompletions: downloads, sharedProxyChanges: proxyChanges, backgroundErrorIsolated: true, nativeLinkProtected: true, realPreloadIpcSelection: true, lateClosedEventsIgnored: true });
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  clearTimeout(watchdog); tabs.dispose(); for (const client of clients.values()) client.end(); server.close(); window.destroy(); app.exit(0);
}).catch(fail);
