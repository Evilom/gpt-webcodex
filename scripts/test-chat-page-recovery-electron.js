'use strict';
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatViewController } = require('../electron/chatViewController');
const { inspectLoginDocument } = require('../electron/services/chatLoginPolicy');
const output = path.join(__dirname, '../build/chat-page-recovery.json');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'thinktank-page-recovery-')));
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { ok: false };
const finish = (code, error) => {
  clearTimeout(watchdog);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ ...report, ...(error ? { error: error.stack } : {}) }, null, 2));
  app.exit(code);
};
const watchdog = setTimeout(() => finish(1, new Error('Page recovery smoke timed out')), 25000);
async function until(check) {
  const end = Date.now() + 3000;
  while (Date.now() < end) { if (await check()) return; await delay(30); }
  throw new Error('Page recovery condition timed out');
}
app.whenReady().then(async () => {
  let releaseResponse, slowRequested = false;
  const pendingResponse = new Promise(resolve => { releaseResponse = resolve; });
  const html = '<main id="preserved"><textarea id="prompt-textarea">未发送的草稿</textarea></main>';
  session.fromPartition('persist:chatgpt-session').protocol.handle('https', async request => {
    const url = new URL(request.url);
    assert.equal(url.hostname, 'chatgpt.com');
    if (url.pathname === '/c/slow') { slowRequested = true; await pendingResponse; }
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
  const window = new BrowserWindow({ show: false });
  const controller = new ChatViewController({ window, settings: { load: () => ({ continuousMcpMode: false }) }, log: { info() {}, warn() {}, error() {} } });
  controller.applyBrowserProxyPolicy = async () => {};
  controller.loadHome = async () => {};
  controller.startLoginWatch = controller.probeLogin = () => {};
  controller.scheduleMemoryObserver = controller.scheduleContinuousMcpMode = () => {};
  controller.mount();
  const contents = controller.view.webContents;
  await contents.loadURL('https://chatgpt.com/c/ready');
  assert.equal(await controller.verifyLoadedDocument(contents), true);
  let stops = 0;
  const stop = contents.stop.bind(contents);
  contents.stop = () => { stops++; stop(); };
  const navigation = contents.loadURL('https://chatgpt.com/c/slow');
  await until(() => slowRequested && contents.isLoadingMainFrame());
  controller.armLoadDeadline(contents, 40);
  await until(() => controller.lastError.includes('仍在等待'));
  assert.equal(stops, 0);
  assert.equal(contents.isLoadingMainFrame(), true);
  releaseResponse(); await navigation;
  await until(() => !controller.lastError);
  report.slowNavigationPreserved = true;

  await contents.executeJavaScript('document.documentElement.remove();true;');
  assert.equal(await controller.verifyLoadedDocument(contents), false);
  assert.match(controller.lastError, /内容为空/);
  contents.emit('responsive');
  await delay(80);
  assert.match(controller.lastError, /内容为空/);
  await contents.loadURL('https://chatgpt.com/c/recovered');
  await until(() => !controller.lastError);
  report.emptyDocumentNotHealthy = true;
  report.validDocumentRecovers = true;

  await contents.executeJavaScript(`window.savedEditor=document.getElementById('prompt-textarea');const fragment=document.createDocumentFragment();for(let i=0;i<2000;i++){const button=document.createElement('button');button.textContent='历史操作 '+i;fragment.append(button);}document.querySelector('main').append(fragment);true;`);
  const probe = await contents.executeJavaScript(`(()=>{let layouts=0;const getComputedStyle=node=>{layouts++;return window.getComputedStyle(node);};const result=(${inspectLoginDocument.toString()})();return {layouts,composer:result.composer,sameEditor:window.savedEditor===document.getElementById('prompt-textarea'),draft:window.savedEditor.value};})()`);
  assert.equal(probe.composer, true);
  assert.equal(probe.layouts, 1);
  assert.equal(probe.sameEditor, true);
  assert.equal(probe.draft, '未发送的草稿');
  report.historyControls = 2000;
  report.loginLayoutChecks = probe.layouts;
  controller.dispose(); window.destroy();
  report.ok = true;
  console.log(JSON.stringify(report));
  finish(0);
}).catch(error => finish(1, error));
