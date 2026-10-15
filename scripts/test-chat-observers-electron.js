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
  controller.dispose();
  window.destroy();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ ok: true, generatingMs, stoppedAfterNativeConfirmation: true }, null, 2));
  app.exit(0);
}).catch(async error => {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ ok: false, error: error.stack, diagnostics: await diagnostics() }, null, 2));
  app.exit(1);
});
