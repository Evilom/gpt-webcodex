'use strict';
const { app, BrowserWindow, WebContentsView } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const scale = Number(process.env.SHELL_SMOKE_SCALE || 1);
if (![1, 1.25, 1.5, 2].includes(scale)) throw new Error('Unsupported smoke scale');
if (scale !== 1) app.commandLine.appendSwitch('force-device-scale-factor', String(scale));
if (process.env.SHELL_SMOKE_MOTION === 'reduce') app.commandLine.appendSwitch('force-prefers-reduced-motion');
const output = path.join(root, 'build', scale === 1 ? 'shell-smoke' : `shell-smoke-${String(scale).replace('.', '-')}`);
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'think-tank-ui-smoke-')));
app.on('window-all-closed', () => {});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];
const probeLayout = require('./ui-layout-probe');
let stage = 'start';
async function settleRenderer() {
  const deadline = performance.now() + 3000;
  let previous = '', stable = 0;
  while (performance.now() < deadline) {
    // Assert final geometry deterministically even when Windows occludes the fixture.
    for (const animation of document.getAnimations()) {
      if (animation.playState === 'running' && Number.isFinite(animation.effect.getComputedTiming().endTime)) animation.finish();
    }
    // Exercise the production layout calculation without relying on occluded rAF.
    if (typeof syncChatContentInsets === 'function') syncChatContentInsets();
    const current = JSON.stringify(Array.from(document.querySelectorAll('.browser-toolbar,#workbench,#previewChat,#studioSidebar,#shellFooter'), el => {
      const rect = el.getBoundingClientRect(); return [rect.x,rect.y,rect.width,rect.height];
    }));
    stable = current === previous ? stable + 1 : 0; previous = current;
    if (stable >= 3) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('isolated renderer layout did not settle');
}
async function settleLayout(win) {
  await win.webContents.executeJavaScript(`(${settleRenderer.toString()})()`);
}
async function captureBounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('capture timed out')), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function captureFixture(win) {
  try {
    const image = await captureBounded(win.capturePage(undefined, { stayHidden: true, stayAwake: true }));
    if (!image.isEmpty()) return image;
  } catch (error) { if (!/UnknownVizError|surface|capture timed out/i.test(error.message)) throw error; }
  const bounds = win.getBounds(), wasVisible = win.isVisible(); win.setBounds({ ...bounds, x: -10000, y: -10000 }, false); win.showInactive();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await delay(200);
      try {
        const image = await captureBounded(win.capturePage());
        if (image.isEmpty()) throw new Error('Empty capture');
        return image;
      } catch (error) { if (attempt === 2 || !/UnknownVizError|surface|Empty capture|capture timed out/i.test(error.message)) throw error; }
    }
  } finally { if (!wasVisible) win.hide(); win.setBounds(bounds, false); }
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
  const window = new BrowserWindow({ show: false, frame:false, thickFrame:false, useContentSize:true, x:-10000, y:-10000, width: 1440, height: 1024, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.showInactive();
  window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  const results = [];
  for (const item of [
    { name: 'dark-ready', width: 1440, height: 1024, theme: 'dark', scenario: 'ready', open: false },
    { name: 'dark-workbench', width: 1440, height: 1024, theme: 'dark', scenario: 'ready', open: true },
    { name: 'dark-interrupted', width: 1440, height: 1024, theme: 'dark', scenario: 'interrupted', open: true },
    { name: 'light-workbench', width: 1440, height: 1024, theme: 'light', scenario: 'ready', open: true },
    { name: 'black-workbench', width: 1440, height: 1024, theme: 'black', scenario: 'ready', open: true },
    { name: 'narrow-960', width: 960, height: 640, theme: 'dark', scenario: 'interrupted', open: true },
    { name: 'narrow-640', width: 640, height: 600, theme: 'dark', scenario: 'interrupted', open: true },
    { name: 'dark-goal', width: 1440, height: 1024, theme: 'dark', scenario: 'ready', open: true, goal: true },
    { name: 'light-goal', width: 1440, height: 1024, theme: 'light', scenario: 'ready', open: true, goal: true },
    { name: 'black-goal', width: 960, height: 720, theme: 'black', scenario: 'ready', open: true, goal: true }
  ]) {
    stage = item.name;
    window.setContentSize(item.width, item.height);
    await window.loadURL(`${previewUrl}/?theme=${item.theme}&scenario=${item.scenario}&workbench=${item.open ? '1' : '0'}`);
    await settleLayout(window);
    if (item.goal) {
      await window.webContents.executeJavaScript(`document.getElementById('goalModeButton').click();document.getElementById('goalObjective').value='核对已有成果，完成剩余步骤并提供验证记录';document.getElementById('goalStart').click();true;`);
      await settleLayout(window);
      const enabled = await window.webContents.executeJavaScript(`({open:document.getElementById('goalModeDetails').open,badge:document.getElementById('goalModeBadge').textContent,locked:document.getElementById('goalObjective').disabled,overflow:document.getElementById('goalModePanel').scrollWidth>document.getElementById('goalModePanel').clientWidth})`);
      assert.equal(enabled.open, true); assert.match(enabled.badge, /进行中/); assert.equal(enabled.locked, true); assert.equal(enabled.overflow, false);
    }
    const geometry = await window.webContents.executeJavaScript(`(() => {
      const rect = (id) => { const r = document.querySelector(id).getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom }; };
      const ids = Array.from(document.querySelectorAll('[id]'), el => el.id);
      return { toolbar:rect('.browser-toolbar'), panel:rect('#workbench'), frame:rect('#previewChat'), footer:rect('#shellFooter'), duplicates:ids.filter((id,index) => ids.indexOf(id)!==index), buttons:Array.from(document.querySelectorAll('.toolbar-main button'), el=>({id:el.id,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,visible:!!el.getBoundingClientRect().width,right:el.getBoundingClientRect().right})), overflow:document.documentElement.scrollWidth > innerWidth, incident:!document.querySelector('#connectionIncident').hidden, localTask:document.getElementById('taskStatusLabel').textContent };
    })()`);
    assert.deepEqual(geometry.duplicates, []);
    assert.equal(geometry.overflow, false, item.name);
    assert.equal(geometry.incident, item.scenario === 'interrupted');
    assert.equal(geometry.localTask, '空闲', 'page interruption must not mark a local task failed');
    if (item.theme === 'black') {
      const colors = await window.webContents.executeJavaScript(`['body','.browser-toolbar','.workbench'].map(selector=>getComputedStyle(document.querySelector(selector)).backgroundColor)`);
      assert.deepEqual(colors,['rgb(0, 0, 0)','rgb(0, 0, 0)','rgb(0, 0, 0)']);
    }
    assert.ok(geometry.buttons.every((button) => !button.visible || button.height <= 40 && button.right <= item.width + 1), `toolbar controls clipped: ${item.name}: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(geometry.frame.y - geometry.toolbar.height) <= 1);
    assert.ok(Math.abs(geometry.frame.x - geometry.toolbar.x) <= 1, `native chat must leave navigation space: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.frame.x,0, 'native GPT keeps the full left edge');
    assert.ok(Math.abs(geometry.frame.bottom - geometry.footer.y) <= 1);
    if (item.open) assert.ok(Math.abs(geometry.frame.right - geometry.panel.x) <= 1, `${item.name}: ${JSON.stringify(geometry)}`);
    fs.writeFileSync(path.join(output, `${item.name}.png`), (await captureFixture(window)).toPNG());
    if (item.goal) {
      const controls = await window.webContents.executeJavaScript(`(async () => {
        async function action(id, expected) {
          for(let index=0;index<40&&document.getElementById(id).disabled;index++)await new Promise(resolve=>setTimeout(resolve,10));
          document.getElementById(id).click();
          for(let index=0;index<40;index++){if(document.getElementById('goalModeBadge').textContent.includes(expected))return;await new Promise(resolve=>setTimeout(resolve,10));}
          throw new Error('目标控制没有更新到 '+expected);
        }
        await action('goalPause','已暂停'); await action('goalResume','进行中'); await action('goalStop','已结束');
        window.goalModeView.render({...lastChatState,url:'https://chatgpt.com/c/another-goal-fixture',goal:null});
        return {cleared:document.getElementById('goalObjective').value==='',startVisible:!document.getElementById('goalStart').hidden};
      })()`);
      assert.equal(controls.cleared, true); assert.equal(controls.startVisible, true);
    }
    results.push({ ...item, geometry });
  }
  const expandedSidebars=[];
  for (const theme of ['dark','light','black']) for (const width of [1440,960]) {
    stage = `expanded-${theme}-${width}`;
    window.setContentSize(width,width===960?640:720);
    await window.loadURL(`${previewUrl}/?theme=${theme}&workbench=1`); await settleLayout(window);
    await window.webContents.executeJavaScript(`(() => {
      document.getElementById('studioConnectionsTab').click();
      document.getElementById('workspaceHealthButton').click(); document.getElementById('contextUsageButton').click();
    })()`);
    await settleLayout(window);
    const connections = await window.webContents.executeJavaScript(`(${probeLayout.toString()})('.workbench .popover-header,.workbench .popover-actions,.workbench .workspace-quick-tools,.workbench .popover-grid,.workbench .health-row>div')`);
    assert.deepEqual(connections.issues, [], `${theme}/${width} expanded connections`);
    assert.equal(connections.bodyOverflow, false);
    fs.writeFileSync(path.join(output, `connections-${theme}-${width}.png`), (await captureFixture(window)).toPNG());
    await window.webContents.executeJavaScript(`(async()=>{
      document.getElementById('studioAdvisorsTab').click();
      const job={id:'expanded_layout_fixture',status:'completed',responses:[{model:'anthropic::claude-opus-5-5',status:'answered',answer:'这是一段较长的设计审查意见，需要独立滚动阅读。\\n'.repeat(80)},{model:'google::gemini-3.8-flash-high',status:'answered',answer:'这是另一段较长的辅助分析意见。\\n'.repeat(60)}]};
      window.browserAssistant.advisoryResult=()=>Promise.resolve({ok:true,data:job});
      window.browserAssistant.advisoryStatus=()=>Promise.resolve({ok:true,data:{configured:true,models:[],selected:[],job}});
      document.getElementById('advisoryResult').click(); await new Promise(resolve=>setTimeout(resolve,80));
      document.querySelectorAll('#studioAdvisorsPanel details').forEach(el=>el.open=true);
    })()`);
    await settleLayout(window);
    const layout=await window.webContents.executeJavaScript(`(${probeLayout.toString()})('.workbench .advisory-actions')`);
    assert.deepEqual(layout.issues,[],`${theme}/${width} expanded workbench`); assert.equal(layout.bodyOverflow,false);
    assert.ok(layout.scrollbars.length&&layout.scrollbars.every(s=>s.width==='6px'&&s.track==='rgba(0, 0, 0, 0)'&&s.buttons==='none'&&s.nativeWidth==='auto'),'shared workbench scrollbars');
    const reading=await window.webContents.executeJavaScript(`(() => {
      const panel=document.querySelector('.workbench-content'),answers=Array.from(document.querySelectorAll('.advisory-answers p'));
      const before=answers.map(el=>el.textContent); panel.scrollTop=panel.scrollHeight;
      const bounds=document.querySelector('#workbench').getBoundingClientRect();
      return {panelBounds:[bounds.left,bounds.right],scrolls:panel.scrollHeight>panel.clientHeight,contentHeight:panel.clientHeight,bodyBounded:answers.length===2&&answers.every(el=>el.clientHeight<=240&&el.scrollHeight>el.clientHeight),font:answers.map(el=>getComputedStyle(el).fontSize),retained:answers.every((el,i)=>el.textContent===before[i]),endReachable:document.getElementById('studioAdvisorsPanel').getBoundingClientRect().bottom<=panel.getBoundingClientRect().bottom+2};
    })()`);
    assert.ok(reading.scrolls&&reading.contentHeight>150&&reading.bodyBounded&&reading.retained&&reading.endReachable);
    assert.deepEqual(reading.font,['16px','16px']);
    assert.ok(reading.panelBounds[0]>=0&&Math.abs(reading.panelBounds[1]-width)<=1);
    await window.webContents.executeJavaScript(`const panel=document.querySelector('.workbench-content');panel.scrollTop=document.querySelector('.advisory-answers').offsetTop-panel.offsetTop`); await delay(80);
    fs.writeFileSync(path.join(output,`expanded-workbench-${theme}-${width}.png`),(await captureFixture(window)).toPNG());
    expandedSidebars.push({theme,width,connections,layout,reading});
  }
  stage = 'task-feedback';
  const taskFeedback = [];
  for (const theme of ['dark','light','black']) for (const width of [1440,640]) for (const [phase,group,checked] of [
    ['running','当前进展',1],['waiting','本地步骤已保存',3],['attention','待处理事项',3],['completed','本次摘要',4]
  ]) {
    window.setContentSize(width,720);
    await window.loadURL(`${previewUrl}/?theme=${theme}&scenario=design&phase=${phase}&workbench=1&panel=activity`); await settleLayout(window);
    const state = await window.webContents.executeJavaScript(`(async()=>{
      const first=document.querySelector('#studioPlanSteps li'); await refreshTask();
      const plan=document.getElementById('studioTaskPlan');
      return {group:document.getElementById('studioRecapLabel').textContent,label:document.getElementById('taskStatusLabel').textContent,checked:document.querySelectorAll('#studioPlanSteps input:checked').length,steps:document.querySelectorAll('#studioPlanSteps li').length,plan:!plan.hidden,recap:!document.getElementById('studioTaskRecap').hidden,retained:first===document.querySelector('#studioPlanSteps li'),nextHidden:document.getElementById('studioTaskNext').hidden,layout:(${probeLayout.toString()})('.studio-task-plan>summary,.studio-task-plan li')};
    })()`);
    assert.equal(state.group,group,phase); assert.equal(state.checked,checked,phase); assert.equal(state.steps,4);
    if (phase==='attention') assert.equal(state.label,'等待处理');
    assert.ok(state.plan&&state.recap&&state.retained); assert.equal(state.nextHidden,phase==='completed');
    assert.deepEqual(state.layout.issues,[],`${theme}/${width}/${phase}`); assert.equal(state.layout.bodyOverflow,false);
    if (theme==='black' && ['waiting','attention'].includes(phase)) fs.writeFileSync(path.join(output,`task-${phase}-${theme}-${width}.png`),(await captureFixture(window)).toPNG());
    taskFeedback.push({theme,width,phase,state});
  }
  const stateChange = await window.webContents.executeJavaScript(`(async()=>{
    document.getElementById('studioTaskPlan').open=false;
    document.getElementById('workbenchActivity').click();
    document.querySelector('#previewDemoDialog button').click(); await refreshTask();
    const running=document.getElementById('studioRecapLabel').textContent==='当前进展';
    document.getElementById('workbenchActivity').click();
    Array.from(document.querySelectorAll('#previewDemoDialog button')).find(el=>el.textContent==='等待网页').click(); await refreshTask();
    const waiting=document.getElementById('studioRecapLabel').textContent==='本地步骤已保存';
    const collapsed=!document.getElementById('studioTaskPlan').open;
    const changed=document.querySelectorAll('#studioPlanSteps .studio-step-changed').length;
    await refreshTask();
    return {running,waiting,collapsed,changed,planCount:document.getElementById('studioPlanCount').textContent};
  })()`);
  assert.ok(stateChange.running&&stateChange.waiting&&stateChange.collapsed&&stateChange.changed);
  assert.equal(stateChange.planCount,'3 / 4');
  stage = 'chat-appearance-toggle';
  const chatAppearanceUi = [];
  for (const width of [1440,640]) {
    window.setContentSize(width,720);
    await window.loadURL(previewUrl+'/?theme=black&scenario=chat-skin');await settleLayout(window);
    const checks = await window.webContents.executeJavaScript(`(async()=>{
      const frame=document.getElementById('previewChat'),doc=frame.contentDocument;
      const editor=doc.getElementById('prompt-textarea');editor.textContent='保留中的网页草稿';
      const original=doc.querySelector('[data-message-author-role=assistant]');
      doc.getElementById('toolActivity').open=true;
      const text=original.innerHTML;
      const off=!document.getElementById('chatAppearanceToggle').checked;
      const before=JSON.stringify(frame.getBoundingClientRect().toJSON());
      document.getElementById('moreButton').click();await (${settleRenderer.toString()})();
      const menu=document.getElementById('moreMenu').getBoundingClientRect();
      const overlay=before===JSON.stringify(frame.getBoundingClientRect().toJSON())&&document.getElementById('moreMenu').matches(':popover-open')&&menu.top>=0&&menu.bottom<=innerHeight&&menu.right<=innerWidth;
      document.getElementById('chatAppearanceToggle').click();await new Promise(resolve=>setTimeout(resolve,80));
      const on=document.getElementById('chatAppearanceToggle').checked&&doc.documentElement.getAttribute('data-thinktank-chat')==='claude'&&getComputedStyle(doc.getElementById('stage-sidebar')).display==='none';
      const same=original===doc.querySelector('[data-message-author-role=assistant]')&&text===original.innerHTML&&editor.textContent==='保留中的网页草稿'&&doc.getElementById('toolActivity').open;
      document.getElementById('chatAppearanceToggle').click();await new Promise(resolve=>setTimeout(resolve,80));
      const restored=!doc.documentElement.hasAttribute('data-thinktank-chat')&&getComputedStyle(doc.getElementById('stage-sidebar')).display!=='none';
      document.getElementById('moreButton').click();await (${settleRenderer.toString()})();
      return {off,on,same,restored,overlay};
    })()`);
    for(const [name,value] of Object.entries(checks)) assert.equal(value,true,'chat appearance UI '+width+'/'+name);
    chatAppearanceUi.push({width,checks});
  }
  stage = 'interactions';
  window.setContentSize(1440, 900);
  await window.loadURL(`${previewUrl}/?theme=dark`);
  await settleLayout(window);
  const interactions = await window.webContents.executeJavaScript(`(async () => {
    const click = id => document.getElementById(id).click();
    const wait = ${settleRenderer.toString()};
    const key = (id, value) => document.getElementById(id).dispatchEvent(new KeyboardEvent('keydown', {key:value,bubbles:true}));
    click('workbenchToggle'); await wait();
    const opened = !document.getElementById('workbench').hidden;
    const activeTab = name => {
      const tabs = Array.from(document.querySelectorAll('[data-studio-tab]'));
      return tabs.filter(el => el.getAttribute('aria-selected') === 'true').length === 1 && tabs.filter(el => el.tabIndex === 0).length === 1 && tabs.find(el => el.tabIndex === 0).dataset.studioTab === name && Array.from(document.querySelectorAll('[data-studio-panel]')).every(el => el.hidden === (el.dataset.studioPanel !== name));
    };
    const tabsExclusive = activeTab('activity');
    document.getElementById('studioActivityTab').focus(); key('studioActivityTab','ArrowRight'); await wait();
    const keyboardNext = activeTab('advisors') && document.activeElement.id === 'studioAdvisorsTab';
    key('studioAdvisorsTab','End'); await wait();
    const keyboardEnd = activeTab('connections') && document.activeElement.id === 'studioConnectionsTab';
    key('studioConnectionsTab','Home'); await wait();
    key('studioActivityTab','ArrowLeft'); await wait();
    const keyboardWrap = activeTab('connections') && document.activeElement.id === 'studioConnectionsTab';
    const handle = document.getElementById('workbenchResize');
    const initialWidth = document.getElementById('workbench').getBoundingClientRect().width;
    key('workbenchResize','ArrowLeft'); await wait();
    const resizeStep = Math.abs(document.getElementById('workbench').getBoundingClientRect().width - initialWidth - 20) <= 1;
    key('workbenchResize','End'); await wait();
    const resizeMax = Math.abs(document.getElementById('workbench').getBoundingClientRect().width - Number(handle.getAttribute('aria-valuemax'))) <= 1;
    key('workbenchResize','Home'); key('workbenchResize','ArrowRight'); await wait();
    const resizeMin = Math.abs(document.getElementById('workbench').getBoundingClientRect().width - 280) <= 1;
    click('closeWorkbench'); await wait();
    const closed = document.getElementById('workbench').hidden;
    const closeFocus = document.activeElement.id === 'workbenchToggle';
    click('workbenchToggle'); await wait();
    const panelStateRetained = activeTab('connections') && Math.abs(document.getElementById('workbench').getBoundingClientRect().width - 280) <= 1;
    click('closeWorkbench'); await wait();
    click('moreButton'); await wait();
    const more = !document.getElementById('moreMenu').hidden;
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})); await wait();
    const escaped = document.getElementById('moreMenu').hidden;
    window.studioShell.showTab('advisors');
    const compactAdvisorDefault = !document.getElementById('advisorSettings').open && document.getElementById('imageJobsSection').hidden;
    click('advisorImagesTab'); await wait();
    const advisorViewsExclusive = document.getElementById('advisorModelsView').hidden && !document.getElementById('imageJobsSection').hidden;
    document.getElementById('advisorImagesTab').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft'})); await wait();
    const advisorKeyboard = document.activeElement.id === 'advisorModelsTab' && !document.getElementById('advisorModelsView').hidden && document.getElementById('imageJobsSection').hidden;
    document.getElementById('advisorSettings').open=true; click('advisoryRefresh'); await wait();
    const check = document.querySelector('#extensionProviders input'); check.click(); await wait();
    const consulted = !document.getElementById('advisoryQuestion') && !document.getElementById('advisorySubmit') && document.getElementById('advisoryStatus').textContent.includes('AI 辅助已启用');
    const providers=document.getElementById('extensionProviders');
    const argon=providers.querySelector('input[value="google::gemini-4-argon"]');
    const argonPromoted=!!argon&&!argon.closest('#extensionProviders details');
    const otherModels=providers.querySelector('details'); otherModels.open=true;
    click('advisoryRefresh'); await wait();
    const modelListStatePreserved=providers.querySelector('details').open;
    providers.querySelector('input[value="google::gemini-3.8-flash-high"]').click(); await wait();
    const selectedModelVisible=!providers.querySelector('input[value="google::gemini-3.8-flash-high"]').closest('#extensionProviders details');
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
    click('studioActivityTab'); await wait();
    click('studioAdvisorsTab'); await wait();
    const answerTabStatePreserved = document.querySelector('#advisoryAnswers details').open && document.querySelector('#advisoryAnswers p').scrollTop === 100;
    advisoryFixture.id='collapse_fixture_456';
    click('advisoryResult'); await wait();
    const nextAnswersCollapsed = Array.from(document.querySelectorAll('#advisoryAnswers details')).every(card=>!card.open);
    click('openTerminalButton'); await wait();
    const consoleOpen = !document.getElementById('taskConsoleDrawer').hidden;
    click('closeConsoleBtn'); await wait();
    const consoleClosed = document.getElementById('taskConsoleDrawer').hidden;
    const historyBefore = JSON.stringify(document.getElementById('previewChat').getBoundingClientRect().toJSON());
    click('openTaskHistoryButton'); await wait();
    const history = document.getElementById('taskHistoryPopover').getBoundingClientRect();
    const frame = document.getElementById('previewChat').getBoundingClientRect();
    const historyOverlay = !document.getElementById('taskHistoryPopover').hidden && document.getElementById('taskHistoryPopover').matches(':popover-open') && historyBefore===JSON.stringify(frame.toJSON()) && history.top>=0&&history.bottom<=innerHeight;
    const actions=[];
    window.browserAssistant.navigate = action => { actions.push('navigate:'+action); return Promise.resolve({ok:true,data:{}}); };
    window.browserAssistant.openWorkspaceWindow = () => { actions.push('workspaces'); return Promise.resolve({ok:true,data:{}}); };
    window.browserAssistant.openManager = () => { actions.push('settings'); return Promise.resolve({ok:true,data:{}}); };
    window.browserAssistant.switchWorkspace = path => { actions.push('workspace:'+path); return Promise.resolve({ok:true,data:{}}); };
    click('homeButton'); click('workspacePickerButton'); click('managerButton');
    await wait();
    const navigationMapped = actions.includes('navigate:home') && actions.includes('workspaces') && actions.includes('settings');
    return {opened,closed,tabsExclusive,keyboardNext,keyboardEnd,keyboardWrap,resizeStep,resizeMax,resizeMin,closeFocus,panelStateRetained,more,escaped,compactAdvisorDefault,advisorViewsExclusive,advisorKeyboard,consulted,argonPromoted,answersCollapsed,modelListStatePreserved,selectedModelVisible,answersScrollable,answerStatePreserved,answerTabStatePreserved,nextAnswersCollapsed,consoleOpen,consoleClosed,historyOverlay,navigationMapped};
  })()`);
  for (const [name, value] of Object.entries(interactions)) assert.equal(value, true, name);
  await window.webContents.executeJavaScript(`toggleWorkbench(true)`); await settleLayout(window);
  // Hosted runners can request reduced motion. This case specifically tests
  // cancellation of an animated exit; reduced-motion closure is tested below.
  const defaultReducedMotion = await window.webContents.executeJavaScript(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  const rapidReopen = await window.webContents.executeJavaScript(`(() => {
    toggleWorkbench(false);
    const exiting=document.getElementById('workbench').inert&&!document.getElementById('workbench').hidden;
    toggleWorkbench(true);
    return exiting&&!document.getElementById('workbench').inert&&!document.getElementById('workbench').hidden;
  })()`);
  await settleLayout(window);
  assert.equal(rapidReopen,true,'reopening cancels the exit without hiding the active pane');
  assert.equal(await window.webContents.executeJavaScript(`document.getElementById('workbench').hidden`),false);
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
  window.webContents.debugger.detach();
  stage = 'native-width';
  const nativeWidth = [];
  for (const width of [640,960,1440]) {
    window.setContentSize(width,720); await settleLayout(window);
    await window.webContents.executeJavaScript('toggleWorkbench(true)'); await settleLayout(window);
    const state = await window.webContents.executeJavaScript(`({left:document.getElementById('previewChat').getBoundingClientRect().left,width:document.getElementById('previewChat').getBoundingClientRect().width,duplicateSidebar:!!document.getElementById('studioSidebar')})`);
    assert.equal(state.left,0); assert.equal(state.duplicateSidebar,false); assert.ok(state.width>=240);
    nativeWidth.push({width,...state});
  }
  stage = 'reduced-motion';
  let reducedMotion;
  window.webContents.debugger.attach('1.3');
  try {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await window.webContents.executeJavaScript(`window.studioShell.showTab('advisors')`);
    reducedMotion = await window.webContents.executeJavaScript(`({requested:matchMedia('(prefers-reduced-motion: reduce)').matches,styles:Array.from(document.querySelectorAll('.studio-sidebar,.browser-toolbar,.shell-footer,.workbench-header,.studio-panel-tabs,[data-studio-panel]'),el=>({animation:getComputedStyle(el).animationName,transition:getComputedStyle(el).transitionDuration}))})`);
    assert.equal(reducedMotion.requested,true);
    assert.ok(reducedMotion.styles.every(style=>style.animation==='none'&&style.transition==='0s'),'reduced motion disables pane and layout animation');
    reducedMotion.immediateClose = await window.webContents.executeJavaScript(`(() => { toggleWorkbench(false); return document.getElementById('workbench').hidden&&document.getElementById('workbench').inert; })()`);
    assert.equal(reducedMotion.immediateClose,true,'reduced motion also disables the JavaScript exit animation');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  } finally { window.webContents.debugger.detach(); }
  stage = 'native-geometry';
  const { ChatViewController } = require('../electron/chatViewController');
  window.setContentSize(640,600);
  const controller = new ChatViewController({ window, toolbarHeight: 56, settings: { load: () => ({}) }, log: { info(){},warn(){},error(){} } });
  controller.applyBrowserProxyPolicy = async () => {};
  controller.loadHome = async () => {};
  controller.mount();
  await controller.view.webContents.loadURL('data:text/html,<p>isolated native geometry fixture</p>');
  const authView = new WebContentsView({ webPreferences: { sandbox:true,contextIsolation:true,nodeIntegration:false } });
  window.contentView.addChildView(authView); controller.authViews.push(authView);
  await authView.webContents.loadURL('data:text/html,<p>isolated authentication geometry fixture</p>');
  controller.setContentInsets({ toolbarHeight: 108, top:24, left:240, right:300, bottom:36 });
  const bounds = controller.view.getBounds();
  const authBounds = authView.getBounds();
  assert.deepEqual(bounds, { x: 240, y: 132, width: 240, height: 432 });
  assert.deepEqual(authBounds, { x: 240, y: 108, width: 240, height: 456 });
  controller.setContentInsets({ toolbarHeight:56, bottom:32 });
  assert.deepEqual(controller.view.getBounds(), { x:0,y:56,width:640,height:512 });
  assert.deepEqual(authView.getBounds(), { x:0,y:56,width:640,height:512 });
  controller.dispose();
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, scale, defaultReducedMotion, results, expandedSidebars, taskFeedback, stateChange, chatAppearanceUi, rapidReopen, interactions, nativeWidth, reducedMotion, nativeBounds: bounds, authBounds, errors }, null, 2));
  window.destroy();
  app.exit(0);
}).catch((error) => { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: false, stage, error: error.stack, errors }, null, 2)); app.exit(1); });
