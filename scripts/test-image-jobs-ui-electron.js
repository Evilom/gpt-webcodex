'use strict';
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const codeRoot = process.argv.includes('--archive') ? path.resolve(process.argv[process.argv.indexOf('--archive') + 1]) : root;
const { ImageJobService } = require(path.join(codeRoot, 'electron/services/imageJobService'));
const output = path.join(root, 'build/image-jobs-ui'); fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'thinktank-image-ui-'));
app.setPath('userData', path.join(profile, 'electron-profile'));
const live = process.argv.includes('--integration');
const integration = live ? process.argv[process.argv.indexOf('--integration') + 1] : '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let window;
async function capture() {
  try { const image = await window.capturePage(); if (!image.isEmpty()) return image; }
  catch (error) { if (!/UnknownVizError|surface/i.test(error.message)) throw error; }
  const bounds = window.getBounds(); window.setBounds({ ...bounds, x: -10000, y: -10000 }, false); window.showInactive();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await delay(200);
      try { const image = await window.capturePage(); if (!image.isEmpty()) return image; }
      catch (error) { if (attempt === 2 || !/UnknownVizError|surface/i.test(error.message)) throw error; }
    }
    throw new Error('Empty image jobs capture');
  } finally { window.hide(); window.setBounds(bounds, false); }
}
app.whenReady().then(async () => {
  let run;
  const config = live ? JSON.parse(fs.readFileSync(integration, 'utf8').replace(/^\uFEFF/, '')) : {
    name: 'local-cliproxy-material-jobs', version: 1, proxy_base_url: 'http://127.0.0.1:8317/v1',
    job_runner: path.join(profile, 'jobs.py'), python: process.execPath
  };
  if (!live) {
    fs.writeFileSync(config.job_runner, '# explicit offline fixture');
    const jobDir = path.join(profile, 'jobs', 'fixture_image_001'); fs.mkdirSync(jobDir, { recursive: true });
    const image = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    fs.writeFileSync(path.join(jobDir, 'image.png'), image.toPNG()); fs.writeFileSync(path.join(jobDir, 'preview.jpg'), image.toJPEG(70));
    const jobs = [{ id: 'fixture_image_001', kind: 'image', status: 'succeeded', dimensions: [1, 1] }, { id: 'fixture_image_002', kind: 'image', status: 'running' }, ...Array.from({ length: 10 }, (_, index) => ({ id: `fixture_history_${index}`, kind: 'image', status: 'failed' }))];
    run = async (_python, args) => ({ stdout: JSON.stringify(args.length === 3 ? jobs : jobs.find(job => job.id === args.at(-1))) });
  }
  const service = new ImageJobService({ directory: profile, ...(run ? { run } : {}) });
  await service.importConfiguration(config); service.select(true);
  let previewCalls = 0, activePreviews = 0, peakPreviews = 0; const assetActions = [];
  const safely = fn => async (_event, ...args) => { try { return { ok: true, data: await fn(...args) }; } catch (error) { return { ok: false, error: error.message }; } };
  for (const [name, fn] of Object.entries({
    status: () => service.status(), list: options => service.list(options?.view === 'grid' ? 4 : 5, options), select: enabled => service.select(enabled),
    preview: async id => { previewCalls++; activePreviews++; peakPreviews = Math.max(peakPreviews, activePreviews); try { return await service.preview(id); } finally { activePreviews--; } },
    open: async id => { const target = await service.assetPath(id); assetActions.push({ action: 'open', id, target }); return { opened: true }; },
    save: async id => { const target = await service.assetPath(id); const saved = path.join(output, 'saved-original.png'); await fs.promises.copyFile(target, saved); assetActions.push({ action: 'save', id, target, saved }); return { saved: true }; }
  })) ipcMain.handle(`image-jobs:${name}`, safely(fn));
  const html = fs.readFileSync(path.join(codeRoot, 'renderer/browser.html'), 'utf8');
  const tail = html.slice(html.indexOf('<div class="advisor-views"'));
  const end = tail.search(/\r?\n      <\/div>\r?\n\r?\n    <\/div>/);
  assert.ok(end > 0, 'extract only the advisor panel, never the footer or production scripts');
  const url = file => pathToFileURL(path.join(codeRoot, file)).href;
  const section = tail.slice(0, end).replace(/src="icons\/([^"]+)"/g, (_match, file) => `src="${url('renderer/icons/' + file)}"`);
  fs.writeFileSync(path.join(output, 'fixture.css'), 'body{margin:0;overflow:hidden}#workbench{position:static;display:flex;flex-direction:column;width:100%;height:100vh;border:0;box-sizing:border-box;padding:18px 0 0;overflow:hidden}.workbench-content{flex:1}#imageJobsSection{min-width:0}h1{font-size:18px;margin:0;padding:0 20px}h2{font-size:16px}');
  fs.writeFileSync(path.join(output, 'fixture.html'), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self';script-src 'self';style-src 'self';img-src 'self' data:"><link rel="stylesheet" href="${url('renderer/browser-shell.css')}"><link rel="stylesheet" href="${url('renderer/ui-theme.css')}"><link rel="stylesheet" href="${url('renderer/image-jobs.css')}"><link rel="stylesheet" href="fixture.css"></head><body><script src="${url('renderer/theme-bootstrap.js')}"></script><main id="workbench"><h1>智囊 · 工作台</h1><div class="workbench-content"><div id="studioAdvisorsPanel">${section}</div></div></main><script src="${url('renderer/advisor-views.js')}"></script><script src="${url('renderer/image-jobs.js')}"></script></body></html>`);
  window = new BrowserWindow({ show: false, width: 390, height: 780, webPreferences: { preload: path.join(codeRoot, 'electron/browserPreload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const wait = async expression => { for (let i = 0; i < 100; i++) { if (await window.webContents.executeJavaScript(expression)) return; await delay(50); } throw new Error('UI condition timed out: ' + expression); };
  const reports = [];
  for (const theme of ['light', 'dark', 'black']) {
    await window.loadFile(path.join(output, 'fixture.html'), { query: { theme } });
    await window.webContents.executeJavaScript('document.getElementById("imageJobsListView").click()');
    assert.equal(await window.webContents.executeJavaScript('document.getElementById("imageJobsSection").hidden && !document.getElementById("advisorSettings").open'), true, 'settings and image history do not stack below the model workspace');
    await window.webContents.executeJavaScript('document.getElementById("advisorImagesTab").click()');
    await wait('!document.getElementById("imageJobsRefresh").disabled');
    await window.webContents.executeJavaScript('document.getElementById("imageJobsRefresh").click()');
    await wait('document.querySelectorAll("#imageJobsList details").length > 0 && !document.getElementById("imageJobsEnabled").disabled');
    assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("#imageJobsList details[open]").length'), 0);
    assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("#imageJobsList img[src]").length'), 0, 'collapsed jobs do not load previews');
    const paging = await window.webContents.executeJavaScript('({count:document.querySelectorAll("#imageJobsList details").length, next:!document.getElementById("imageJobsNext").disabled, page:document.getElementById("imageJobsPage").textContent})');
    assert.ok(paging.count <= 5); assert.equal(paging.next, true);
    await capture(); await delay(100);
    fs.writeFileSync(path.join(output, `${theme}-list.png`), (await capture()).toPNG());
    await window.webContents.executeJavaScript('document.getElementById("imageJobsNext").click()');
    await wait('!document.getElementById("imageJobsRefresh").disabled && document.getElementById("imageJobsPage").textContent.startsWith("2 /")');
    await window.webContents.executeJavaScript('document.getElementById("imageJobsPrevious").click()');
    await wait('!document.getElementById("imageJobsRefresh").disabled && document.getElementById("imageJobsPage").textContent.startsWith("1 /")');
    const beforePreview = previewCalls;
    const id = await window.webContents.executeJavaScript('(()=>{const card=document.querySelector("#imageJobsList details[data-status=succeeded]");card.querySelector("summary").click();return card.dataset.id})()');
    await wait('document.querySelector("#imageJobsList details[open] img").naturalWidth > 0');
    assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("#imageJobsList details").length'), 1, 'detail replaces the list instead of expanding the page');
    // Manual refresh is exposed from the list; exercise the same refresh while in detail to protect polling state.
    assert.equal(previewCalls, beforePreview + 1, 'one expanded card loads one preview');
    await window.webContents.executeJavaScript('document.getElementById("imageJobsRefresh").click()');
    await wait('!document.getElementById("imageJobsRefresh").disabled');
    assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("#imageJobsList details[open]").length'), 1);
    assert.equal(previewCalls, beforePreview + 1, 'refresh preserves the loaded preview and fold state');
    await window.webContents.executeJavaScript('document.querySelectorAll("#imageJobsList details[open] button")[1].click()');
    await wait('document.querySelector("#imageJobsList details[open] img").complete');
    for (let i = 0; i < 50 && !assetActions.some(action => action.id === id && action.action === 'save'); i++) await delay(50);
    const saved = assetActions.find(action => action.id === id && action.action === 'save'); assert.ok(saved);
    assert.ok(fs.readFileSync(saved.target).equals(fs.readFileSync(saved.saved)), 'save keeps the real original bytes');
    const layout = await window.webContents.executeJavaScript('({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,bg:getComputedStyle(document.body).backgroundColor,previewWidth:document.querySelector("details[open] img").getBoundingClientRect().width})');
    assert.equal(layout.overflow, false); assert.ok(layout.previewWidth <= layout.width);
    await capture();
    await delay(150);
    const screenshot = await capture(); fs.writeFileSync(path.join(output, `${theme}.png`), screenshot.toPNG());
    reports.push({ theme, id, ...layout });
    await window.webContents.executeJavaScript('document.getElementById("imageJobsBack").click()');
    assert.ok(await window.webContents.executeJavaScript('document.querySelectorAll("#imageJobsList details").length <= 5 && !document.getElementById("imageJobsBack").getBoundingClientRect().height'));
    await window.webContents.executeJavaScript('document.getElementById("imageJobsGridView").click()');
    await wait('!document.getElementById("imageJobsRefresh").disabled && document.querySelectorAll("#imageJobsList details").length === 4 && document.querySelector("#imageJobsList[data-view=grid] img[src]")?.naturalWidth > 0');
    await wait('Array.from(document.querySelectorAll("#imageJobsList details[data-status=succeeded] img")).every(image=>image.naturalWidth>0)');
    assert.ok(peakPreviews <= 2, 'thumbnail reads have bounded concurrency');
    await capture(); await delay(100); fs.writeFileSync(path.join(output, `${theme}-grid.png`), (await capture()).toPNG());
    const grid = await window.webContents.executeJavaScript('({columns:getComputedStyle(document.getElementById("imageJobsList")).gridTemplateColumns.split(" ").length,overflow:document.documentElement.scrollWidth>innerWidth,selected:document.getElementById("imageJobsGridView").getAttribute("aria-pressed")})');
    assert.equal(grid.columns, 2); assert.equal(grid.overflow, false); assert.equal(grid.selected, 'true');
    await window.webContents.executeJavaScript('document.getElementById("imageJobsListView").click()');
    await wait('!document.getElementById("imageJobsRefresh").disabled && document.querySelectorAll("#imageJobsList details").length === 5');
    await window.webContents.executeJavaScript('document.getElementById("imageJobsFilter").value="active";document.getElementById("imageJobsFilter").dispatchEvent(new Event("change"))');
    await wait('!document.getElementById("imageJobsRefresh").disabled');
    assert.equal(await window.webContents.executeJavaScript('Array.from(document.querySelectorAll("#imageJobsList details")).every(card=>["running","queued","submission_unknown"].includes(card.dataset.status))'), true);
  }
  await window.webContents.executeJavaScript('document.getElementById("imageJobsEnabled").click()');
  await wait('!document.getElementById("imageJobsEnabled").disabled'); assert.equal(service.status().enabled, false);
  const report = { ok: true, liveData: live, packaged: codeRoot !== root, previewCalls, peakPreviews, pageSizes: [5, 4], gridColumns: 2, separateViews: true, detailReplacesList: true, savedOriginal: true, noManualSubmit: true, reports };
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}).catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => { window?.destroy(); app.exit(process.exitCode || 0); });
