'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const scale = Number(process.env.SHELL_SMOKE_SCALE || 1);
if (![1, 1.25, 1.5, 2].includes(scale)) throw new Error('Unsupported smoke scale');
if (scale !== 1) app.commandLine.appendSwitch('force-device-scale-factor', String(scale));
const output = path.join(root, 'build', scale === 1 ? 'shell-smoke' : `shell-smoke-${String(scale).replace('.', '-')}`);
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'think-tank-ui-smoke-')));
app.on('window-all-closed', () => {});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];
const probeLayout = require('./ui-layout-probe');
async function captureFixture(win) {
  const bounds=win.getBounds();win.setBounds({...bounds,x:-10000,y:-10000});win.showInactive();
  await delay(180);
  try{return await win.webContents.capturePage();}finally{win.hide();win.setBounds(bounds);}
}
let previewProcess;
function startPreview() {
  return new Promise((resolve, reject) => {
    previewProcess = spawn(process.execPath, [path.join(__dirname, 'shell-preview-server.js')], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SHELL_PREVIEW_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => reject(new Error('隔离预览未启动')), 8000);
    previewProcess.once('error', (error) => { clearTimeout(timer); reject(error); });
    previewProcess.stdout.on('data', (data) => { const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    previewProcess.once('exit', () => { clearTimeout(timer); reject(new Error('隔离预览已退出')); });
  });
}
process.on('exit', () => previewProcess?.kill());
app.whenReady().then(async () => {
  const previewUrl = await startPreview();
  const window = new BrowserWindow({ show: false, width: 1440, height: 1024, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  const results = [];
  for (const item of [
    { name: 'dark-ready', width: 1440, height: 1024, theme: 'dark', scenario: 'ready', open: false },
    { name: 'dark-workbench', width: 1440, height: 1024, theme: 'dark', scenario: 'ready', open: true },
    { name: 'dark-interrupted', width: 1440, height: 1024, theme: 'dark', scenario: 'interrupted', open: true },
    { name: 'light-workbench', width: 1440, height: 1024, theme: 'light', scenario: 'ready', open: true },
    { name: 'narrow-960', width: 960, height: 640, theme: 'dark', scenario: 'interrupted', open: true },
    { name: 'narrow-640', width: 640, height: 600, theme: 'dark', scenario: 'interrupted', open: true }
  ]) {
    window.setContentSize(item.width, item.height);
    await window.loadURL(`${previewUrl}/?theme=${item.theme}&scenario=${item.scenario}&workbench=${item.open ? '1' : '0'}`);
    await delay(300);
    const geometry = await window.webContents.executeJavaScript(`(() => {
      const rect = (id) => { const r = document.querySelector(id).getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom }; };
      const ids = Array.from(document.querySelectorAll('[id]'), el => el.id);
      return { toolbar:rect('.browser-toolbar'), panel:rect('#workbench'), frame:rect('#previewChat'), footer:rect('#shellFooter'), duplicates:ids.filter((id,index) => ids.indexOf(id)!==index), buttons:Array.from(document.querySelectorAll('.toolbar-main button'), el=>({id:el.id,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,visible:!!el.getBoundingClientRect().width,right:el.getBoundingClientRect().right})), overflow:document.documentElement.scrollWidth > innerWidth, incident:!document.querySelector('#connectionIncident').hidden, localTask:document.getElementById('taskStatusLabel').textContent };
    })()`);
    assert.deepEqual(geometry.duplicates, []);
    assert.equal(geometry.overflow, false, item.name);
    assert.equal(geometry.incident, item.scenario === 'interrupted');
    assert.equal(geometry.localTask, '空闲', 'page interruption must not mark a local task failed');
    assert.ok(geometry.buttons.every((button) => !button.visible || button.height <= 40 && button.right <= item.width + 1), `toolbar controls clipped: ${item.name}`);
    assert.ok(Math.abs(geometry.frame.y - geometry.toolbar.height) <= 1);
    assert.ok(Math.abs(geometry.frame.bottom - geometry.footer.y) <= 1);
    if (item.open) assert.ok(Math.abs(geometry.frame.right - geometry.panel.x) <= 1, `${item.name}: ${JSON.stringify(geometry)}`);
    fs.writeFileSync(path.join(output, `${item.name}.png`), (await captureFixture(window)).toPNG());
    results.push({ ...item, geometry });
  }
  const expandedSidebars=[];
  for (const theme of ['dark','light']) for (const width of [1440,960]) {
    window.setContentSize(width,width===960?640:720);
    await window.loadURL(`${previewUrl}/?theme=${theme}&workbench=1`); await delay(180);
    await window.webContents.executeJavaScript(`(async()=>{
      const job={id:'expanded_layout_fixture',status:'completed',responses:[{model:'anthropic::claude-opus-5-5',status:'answered',answer:'这是一段较长的设计审查意见，需要独立滚动阅读。\\n'.repeat(80)},{model:'google::gemini-3.8-flash-high',status:'answered',answer:'这是另一段较长的辅助分析意见。\\n'.repeat(60)}]};
      window.browserAssistant.advisoryResult=()=>Promise.resolve({ok:true,data:job});
      window.browserAssistant.advisoryStatus=()=>Promise.resolve({ok:true,data:{configured:true,models:[],selected:[],job}});
      document.getElementById('advisoryResult').click(); await new Promise(resolve=>setTimeout(resolve,80));
      document.getElementById('workspaceHealthButton').click();document.getElementById('contextUsageButton').click();
      document.querySelectorAll('#workbench details').forEach(el=>el.open=true);
    })()`);
    await delay(120);
    const layout=await window.webContents.executeJavaScript(`(${probeLayout.toString()})('.workbench .advisory-actions,.workbench .popover-header,.workbench .popover-actions,.workbench .workspace-quick-tools,.workbench .popover-grid,.workbench .health-row>div')`);
    assert.deepEqual(layout.issues,[],`${theme}/${width} expanded workbench`); assert.equal(layout.bodyOverflow,false);
    assert.ok(layout.scrollbars.length&&layout.scrollbars.every(s=>s.width==='6px'&&s.track==='rgba(0, 0, 0, 0)'&&s.buttons==='none'&&s.nativeWidth==='auto'),'shared workbench scrollbars');
    const reading=await window.webContents.executeJavaScript(`(() => {
      const panel=document.querySelector('.workbench-content'),answers=Array.from(document.querySelectorAll('.advisory-answers p'));
      const before=answers.map(el=>el.textContent); panel.scrollTop=panel.scrollHeight;
      const bounds=document.querySelector('#workbench').getBoundingClientRect();
      return {panelBounds:[bounds.left,bounds.right],scrolls:panel.scrollHeight>panel.clientHeight,contentHeight:panel.clientHeight,bodyBounded:answers.length===2&&answers.every(el=>el.clientHeight<=240&&el.scrollHeight>el.clientHeight),font:answers.map(el=>getComputedStyle(el).fontSize),retained:answers.every((el,i)=>el.textContent===before[i]),endReachable:document.querySelector('.workbench-actions').getBoundingClientRect().bottom<=panel.getBoundingClientRect().bottom+2};
    })()`);
    assert.ok(reading.scrolls&&reading.contentHeight>150&&reading.bodyBounded&&reading.retained&&reading.endReachable);
    assert.deepEqual(reading.font,['16px','16px']);
    assert.ok(reading.panelBounds[0]>=0&&Math.abs(reading.panelBounds[1]-width)<=1);
    await window.webContents.executeJavaScript(`const panel=document.querySelector('.workbench-content');panel.scrollTop=document.querySelector('.advisory-answers').offsetTop-panel.offsetTop`); await delay(80);
    fs.writeFileSync(path.join(output,`expanded-workbench-${theme}-${width}.png`),(await captureFixture(window)).toPNG());
    expandedSidebars.push({theme,width,layout,reading});
  }
  await window.loadURL(`${previewUrl}/?theme=dark`);
  await delay(100);
  const interactions = await window.webContents.executeJavaScript(`(async () => {
    const click = id => document.getElementById(id).click();
    const wait = () => new Promise(resolve => setTimeout(resolve,50));
    click('workbenchToggle'); await wait();
    const opened = !document.getElementById('workbench').hidden;
    click('closeWorkbench'); await wait();
    const closed = document.getElementById('workbench').hidden;
    click('moreButton'); await wait();
    const more = !document.getElementById('moreMenu').hidden;
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})); await wait();
    const escaped = document.getElementById('moreMenu').hidden;
    click('workbenchToggle'); click('advisoryRefresh'); await wait();
    const check = document.querySelector('#extensionProviders input'); check.click(); await wait();
    const consulted = !document.getElementById('advisoryQuestion') && !document.getElementById('advisorySubmit') && document.getElementById('advisoryStatus').textContent.includes('AI 辅助已启用');
    const providers=document.getElementById('extensionProviders');
    const argon=providers.querySelector('input[value="google::gemini-4-argon"]');
    const argonPromoted=!!argon&&!argon.closest('details');
    const otherModels=providers.querySelector('details'); otherModels.open=true;
    click('advisoryRefresh'); await wait();
    const modelListStatePreserved=providers.querySelector('details').open;
    providers.querySelector('input[value="google::gemini-3.8-flash-high"]').click(); await wait();
    const selectedModelVisible=!providers.querySelector('input[value="google::gemini-3.8-flash-high"]').closest('details');
    const advisoryFixture = {id:'collapse_fixture_123',status:'completed',responses:[{model:'anthropic::claude-opus-5-5',status:'answered',elapsed_seconds:43.28,answer:'这是较长的辅助意见。\\n'.repeat(120)},{model:'google::gemini-3.8-flash-high',status:'answered',elapsed_seconds:22.47,answer:'这是另一份辅助意见。'}]};
    window.browserAssistant.advisoryResult = () => Promise.resolve({ok:true,data:advisoryFixture});
    window.browserAssistant.advisoryStatus = () => Promise.resolve({ok:true,data:{configured:true,models:[],selected:[],job:advisoryFixture}});
    click('advisoryResult'); await wait();
    const cards = Array.from(document.querySelectorAll('#advisoryAnswers details'));
    const answersCollapsed = cards.length === 2 && cards.every(card=>!card.open) && document.getElementById('advisoryAnswers').getBoundingClientRect().height < 160;
    cards[0].querySelector('summary').click(); await wait();
    const body=cards[0].querySelector('p'); body.scrollTop=100;
    const answersScrollable = cards[0].open && body.clientHeight <= 240 && body.scrollHeight > body.clientHeight && cards[1].open === false;
    click('advisoryResult'); await wait();
    const refreshed = document.querySelector('#advisoryAnswers details');
    const answerStatePreserved = refreshed.open && refreshed.querySelector('p').scrollTop === 100;
    advisoryFixture.id='collapse_fixture_456';
    click('advisoryResult'); await wait();
    const nextAnswersCollapsed = Array.from(document.querySelectorAll('#advisoryAnswers details')).every(card=>!card.open);
    click('openTerminalButton'); await wait();
    const consoleOpen = !document.getElementById('taskConsoleDrawer').hidden;
    click('closeConsoleBtn'); await wait();
    const consoleClosed = document.getElementById('taskConsoleDrawer').hidden;
    click('openTaskHistoryButton'); await wait();
    const history = document.getElementById('taskHistoryPopover').getBoundingClientRect();
    const frame = document.getElementById('previewChat').getBoundingClientRect();
    const historyReserved = !document.getElementById('taskHistoryPopover').hidden && frame.bottom <= history.top + 1;
    return {opened,closed,more,escaped,consulted,argonPromoted,modelListStatePreserved,selectedModelVisible,answersCollapsed,answersScrollable,answerStatePreserved,nextAnswersCollapsed,consoleOpen,consoleClosed,historyReserved};
  })()`);
  for (const [name, value] of Object.entries(interactions)) assert.equal(value, true, name);
  const { ChatViewController } = require('../electron/chatViewController');
  window.setContentSize(640,600);
  const controller = new ChatViewController({ window, toolbarHeight: 56, settings: { load: () => ({}) }, log: { info(){},warn(){},error(){} } });
  controller.applyBrowserProxyPolicy = async () => {};
  controller.loadHome = async () => {};
  controller.mount();
  await controller.view.webContents.loadURL('data:text/html,<p>isolated native geometry fixture</p>');
  controller.setContentInsets({ toolbarHeight: 108, right: 300, bottom: 36 });
  const bounds = controller.view.getBounds();
  assert.deepEqual(bounds, { x: 0, y: 108, width: 340, height: 456 });
  controller.dispose();
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, scale, results, expandedSidebars, interactions, nativeBounds: bounds, errors }, null, 2));
  window.destroy();
  app.exit(0);
}).catch((error) => { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: false, error: error.stack, errors }, null, 2)); app.exit(1); });
