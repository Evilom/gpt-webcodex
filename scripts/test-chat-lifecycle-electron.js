'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build', 'chat-lifecycle-smoke.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-lifecycle-')));
const fail = (error) => { fs.writeFileSync(output, JSON.stringify({ ok: false, error: error.stack || String(error) })); app.exit(1); };
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
const { ChatViewController } = require('../electron/chatViewController');
const { finishShutdown } = require('../electron/services/shutdownService');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const results = [];
  for (const busy of [false, true]) {
    const window = new BrowserWindow({ show: false });
    const controller = new ChatViewController({ window, log: { info() {}, warn() {}, error() {} }, settings: { load: () => ({}) } });
    controller.applyBrowserProxyPolicy = async () => {};
    controller.loadHome = async () => {};
    controller.mount();
    const contents = controller.view.webContents;
    await contents.loadURL('data:text/html,<main>isolated lifecycle test</main>');
    await contents.executeJavaScript('window.onbeforeunload = () => false; true;');
    if (busy) {
      await contents.executeJavaScript('setTimeout(() => { const end = Date.now() + 20000; while (Date.now() < end) {} }, 10);');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const started = Date.now();
    await finishShutdown({ tasks: [() => { controller.dispose(); window.destroy(); }], log: { warn() {} }, timeoutMs: 1500, exit: () => {} });
    assert.equal(window.isDestroyed(), true);
    assert.equal(controller.disposed, true);
    results.push({ busyRenderer: busy, elapsedMs: Date.now() - started, closed: true });
  }
  fs.writeFileSync(output, JSON.stringify({ ok: true, results }, null, 2));
  app.exit(0);
}).catch(fail);
