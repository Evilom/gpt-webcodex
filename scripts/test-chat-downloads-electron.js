'use strict';
const { app, BrowserWindow, session, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ChatViewController } = require('../electron/chatViewController');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-download-smoke-'));
const output = path.resolve(__dirname, '../build/chat-download-smoke.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
app.setPath('userData', path.join(root, 'profile'));
app.on('window-all-closed', () => {});
const external = [];
shell.openExternal = async (url) => { external.push(url); };
const fail = (error) => { fs.writeFileSync(output, JSON.stringify({ ok: false, error: String(error.stack || error) }, null, 2)); app.exit(1); };
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
app.whenReady().then(async () => {
  const chatSession = session.fromPartition('persist:chatgpt-session');
  const home = 'https://chatgpt.com/c/download-fixture';
  const bytes = 'isolated-download-fixture';
  chatSession.protocol.handle('https', (request) => new Response(request.url.includes('/download') && !request.url.endsWith('download-fixture') ? bytes : '<main>Download fixture</main>', {
    headers: request.url.endsWith('/download') ? { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="fixture-http.txt"' } : { 'Content-Type': 'text/html' }
  }));
  const window = new BrowserWindow({ show: false });
  const downloads = [], logs = [];
  const controller = new ChatViewController({ window,
    settings: { load: () => ({ workspace: root, proxyMode: 'direct' }) },
    log: { info: (...v) => logs.push(v), warn: (...v) => logs.push(v), error: (...v) => logs.push(v) },
    onDownload: (state) => downloads.push(state)
  });
  controller.applyBrowserProxyPolicy = async () => {};
  controller.loadHome = async () => {};
  controller.mount();
  const contents = controller.view.webContents;
  const results = [];
  for (const mode of ['anchor-blob', 'popup-blob', 'popup-blank', 'popup-http', 'popup-file-host']) {
    await contents.loadURL(home);
    const scrollbars=await contents.executeJavaScript(`(() => {
      const el=document.createElement('div');el.style.cssText='height:20px;overflow:auto;scrollbar-width:thin;scrollbar-color:red white';el.tabIndex=0;el.textContent='长内容。'.repeat(300);document.body.append(el);
      const base={width:getComputedStyle(el,'::-webkit-scrollbar').width,track:getComputedStyle(el,'::-webkit-scrollbar-track').backgroundColor,buttons:getComputedStyle(el,'::-webkit-scrollbar-button').display,nativeWidth:getComputedStyle(el).scrollbarWidth};
      document.documentElement.classList.add('dark');el.focus();base.focusedThumb=getComputedStyle(el,'::-webkit-scrollbar-thumb').backgroundColor;el.scrollTop=el.scrollHeight;base.scrollable=el.scrollTop>0;el.remove();document.documentElement.classList.remove('dark');return base;
    })()`);
    assert.deepEqual(scrollbars,{width:'6px',track:'rgba(0, 0, 0, 0)',buttons:'none',nativeWidth:'auto',focusedThumb:'rgb(85, 85, 85)',scrollable:true},'native ChatGPT scrollbar style and scrolling');
    const before = downloads.length;
    let pageError = '';
    try {
      await contents.executeJavaScript(`(() => {
        const mode=${JSON.stringify(mode)};
        const url=URL.createObjectURL(new Blob([${JSON.stringify(bytes)}], {type:'text/plain'}));
        if(mode==='anchor-blob') { const a=document.createElement('a'); a.href=url; a.download='fixture-anchor.txt'; a.target='_blank'; a.click(); }
        if(mode==='popup-blob') window.open(url, '_blank');
        if(mode==='popup-blank') { const child=window.open('about:blank', '_blank'); if(!child)throw new Error('Download popup was blocked'); child.location.href=url; }
        if(mode==='popup-http') window.open('https://chatgpt.com/backend-api/files/fixture/download', '_blank');
        if(mode==='popup-file-host') window.open('https://files.oaiusercontent.com/fixture/download', '_blank');
        return true;
      })()`, true);
    } catch (error) { pageError = error.message; }
    const deadline = Date.now() + 3500;
    while (!downloads.slice(before).some((item) => ['completed', 'interrupted', 'cancelled'].includes(item.status)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const item = downloads.slice(before).findLast((item) => item.status === 'completed');
    results.push({ mode, downloaded: Boolean(item), correctBytes: item ? fs.readFileSync(item.path, 'utf8') === bytes : false, filenameUsable: item ? path.extname(item.path) === '.txt' : false, pageUnchanged: contents.getURL() === home, pageError });
  }
  const pending = await contents.executeJavaScript('Boolean(window.open("about:blank", "_blank"))', true);
  assert.equal(pending, true);
  assert.equal(controller.downloadViews.length, 1);
  controller.dispose(); window.destroy();
  assert.equal(controller.downloadViews.length, 0);
  const ok = results.every((item) => item.downloaded && item.correctBytes && item.filenameUsable && item.pageUnchanged) && external.length === 0;
  fs.writeFileSync(output, JSON.stringify({ ok, results, external, logs }, null, 2));
  if (!process.argv.includes('--diagnose')) assert.ok(ok, 'All download flows must save their bytes without replacing the chat');
  app.exit(ok || process.argv.includes('--diagnose') ? 0 : 1);
}).catch(fail);
