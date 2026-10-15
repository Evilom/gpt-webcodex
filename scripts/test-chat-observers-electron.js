'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatViewController } = require('../electron/chatViewController');
const output = path.join(__dirname, '../build/chat-observers-smoke.json');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'think-tank-observers-')));
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let diagnostics = async () => ({});
async function until(check, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(40);
  }
  throw new Error('Native state observation timed out');
}
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  const controller = new ChatViewController({ window, settings: { load: () => ({ continuousMcpMode: false }) }, log: { info() {}, warn() {}, error() {} } });
  controller.applyBrowserProxyPolicy = async () => {};
  controller.loadHome = async () => {};
  controller.mount();
  const contents = controller.view.webContents;
  diagnostics = async () => ({ state: controller.streamState, page: await contents.executeJavaScript(`({observer:!!window.__mcpStreamObserver,tokens:window.tokens,timer:!!window.__mcpStreamTimer,due:window.__mcpStreamNextScanAt,rect:document.querySelector('button')?.getBoundingClientRect().toJSON()})`) });
  await contents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<main><p id="tokens"></p><button aria-label="停止">停止</button></main>'));
  await contents.executeJavaScript(`window.tokens=0;window.tokenTimer=setInterval(()=>{document.getElementById('tokens').textContent=String(++window.tokens)},30);true;`);
  const started = Date.now();
  await until(() => controller.streamState.status === 'generating', 1800);
  const generatingMs = Date.now() - started;
  assert.ok(await contents.executeJavaScript('window.tokens>0'));
  await contents.executeJavaScript(`document.querySelector('button').onclick=()=>{window.stopClicked=true;setTimeout(()=>document.querySelector('button').remove(),500)};true;`);
  assert.equal(await controller.stopGeneration(), true);
  assert.equal(controller.streamState.status, 'generating', 'a click alone must not claim generation stopped');
  assert.equal(await contents.executeJavaScript('window.stopClicked'), true);
  await contents.executeJavaScript('clearInterval(window.tokenTimer);true;');
  await until(() => controller.streamState.status === 'healthy');
  await contents.executeJavaScript(`const button=document.createElement('button');button.ariaLabel='停止';button.hidden=true;document.querySelector('main').append(button);true;`);
  await delay(600);
  assert.equal(controller.streamState.status, 'healthy', 'hidden stale controls are ignored');
  // Exercise the actual injected observer in Chromium, including a tool status
  // that changes attributes without producing visible text.
  await contents.executeJavaScript(`document.querySelector('main').innerHTML='<div id="tool" aria-busy="true"></div><button aria-label="停止">停止</button>';true;`);
  await until(() => controller.streamState.status === 'generating');
  await delay(500); // Let the real DOM mutation batch settle before aging its clock.
  await contents.executeJavaScript(`window.__mcpStreamLastActivityAt=Date.now()-415000;true;`);
  controller.scheduleStreamObserver();
  await until(() => controller.streamState.quietSeconds >= 415);
  assert.equal(controller.streamState.stalled, false, 'DOM silence is not a model stall');
  assert.equal(controller.streamState.pageQuiet, true);
  const quietActivityAt = controller.streamState.activityAt;
  await contents.executeJavaScript(`document.getElementById('tool').setAttribute('data-state','completed');true;`);
  await until(() => controller.streamState.activityAt > quietActivityAt && !controller.streamState.pageQuiet);
  const beforeReplacement = controller.streamState.activityAt;
  await delay(30);
  await contents.executeJavaScript(`const replacement=document.createElement('main');replacement.innerHTML='<div id="tool" aria-busy="true"></div><button aria-label="停止">停止</button>';document.querySelector('main').replaceWith(replacement);true;`);
  await until(() => controller.streamState.activityAt > beforeReplacement);
  const replacedActivityAt = controller.streamState.activityAt;
  await delay(30);
  await contents.executeJavaScript(`document.getElementById('tool').setAttribute('aria-busy','false');true;`);
  await until(() => controller.streamState.activityAt > replacedActivityAt);
  const oldDocument = controller.streamDocumentRevision;
  controller.resetStreamDocument();
  contents.emit('console-message', {}, 1, '[web-mcp-stream] '+JSON.stringify({document_id:oldDocument,conversation_id:'',status:'generating',event:'late-old-page'}));
  assert.equal(controller.streamState.status, 'unknown', 'late events from the old document are ignored');
  controller.scheduleStreamObserver();
  await until(() => controller.streamState.status === 'generating');
  await contents.executeJavaScript(`document.querySelector('main').innerHTML='<button data-testid="stop-recording" aria-label="Stop recording">audio</button>';true;`);
  await until(() => controller.streamState.status === 'healthy');
  controller.dispose();
  window.destroy();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ ok: true, generatingMs, stoppedAfterNativeConfirmation: true, quiet415SecondsNotStalled:true, attributeActivity:true, replacementMainObserved:true, oldDocumentIgnored:true, recordingStopIgnored:true }, null, 2));
  app.exit(0);
}).catch(async error => {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ ok: false, error: error.stack, diagnostics: await diagnostics() }, null, 2));
  app.exit(1);
});
