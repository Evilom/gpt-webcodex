'use strict';
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build', 'theme-smoke');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'think-tank-theme-smoke-')));
app.on('window-all-closed', () => {});
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const errors = [], results = [];
const probeLayout = require('./ui-layout-probe');
async function captureBounded(promise) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('capture timed out')),5000);})]); }
  finally { clearTimeout(timer); }
}
async function capture(win) {
  try {
    const image = await captureBounded(win.capturePage(undefined,{stayHidden:true,stayAwake:true}));
    if (!image.isEmpty()) return image;
  } catch (error) { if (!/UnknownVizError|surface|capture timed out/i.test(error.message)) throw error; }
  const bounds = win.getBounds();
  win.setBounds({...bounds,x:-10000,y:-10000}); win.showInactive();
  await delay(250);
  try { return await captureBounded(win.capturePage()); }
  finally { win.hide(); win.setBounds(bounds); }
}
const fixture = { status:'本地步骤已完成，正在等待主 AI 核对较长的设计方案与工程结果', capturedAt:'状态读取 · 刚刚', state:'等待 ChatGPT', stage:'核对工程结果', elapsed:'2 分 18 秒', lastSeen:'刚刚', process:'已结束 · 退出码 0', waitReason:'等待网页回复', nextStep:'由主 AI 核对结果', channel:'MCP · 正常', command:'npm run test', output:'297 项测试通过。\n没有执行中的本地命令。\n'.repeat(30), outputMeta:'最近 90 行', diagnosis:'本地命令已完成，连接正常。'.repeat(8), timeline:[{label:'命令已完成',detail:'回归检查通过 · '+ 'extended_source_file_name_'.repeat(12),time:'09:38:04'}] };
for (const channel of ['activity-detail:hover','activity-detail:close','activity-detail:pin','activity-detail:unpin','approval-window:close','workspace-window:close']) ipcMain.handle(channel, () => ({ok:true,data:true}));
ipcMain.handle('approval:list', () => ({ok:true,data:{pending:[{request_id:'isolated-fixture',action:'演示确认请求',categories:['git_write'],summary:'这是一条离线测试记录，不会执行实际操作。'}]}}));
ipcMain.handle('workspace:hub', () => ({ok:true,data:{activeWorkspace:'C:\\theme-fixture\\projects',workspaces:[{path:'C:\\theme-fixture\\projects',name:'projects',status:'ready',active:true},{path:'C:\\theme-fixture\\RoboSim',name:'RoboSim',status:'ready'}],recentWorkspaces:[],authorizedRoots:['C:\\theme-fixture\\projects'],invalidCount:0}}));
ipcMain.handle('workspace:storage', () => ({ok:true,data:{cacheBytes:0,logBytes:0,totalBytes:0}}));

const appearance = `(() => {
  const style=getComputedStyle(document.body);
  const texts=Array.from(document.querySelectorAll('body *')).filter(el=>el.getClientRects().length && Array.from(el.childNodes).some(n=>n.nodeType===3 && n.textContent.trim()));
  const small=texts.filter(el=>parseFloat(getComputedStyle(el).fontSize)<12).map(el=>({tag:el.tagName,class:el.className,text:el.textContent.slice(0,50),size:getComputedStyle(el).fontSize}));
  return {theme:document.body.dataset.theme,bg:style.backgroundColor,color:style.color,font:style.fontFamily,size:parseFloat(style.fontSize),muted:style.getPropertyValue('--ui-muted').trim(),surface:style.getPropertyValue('--ui-surface').trim(),overflow:document.documentElement.scrollWidth>innerWidth,small};
})()`;

function luminance(hex) {
  const value=hex.replace('#','');
  const full=value.length===3?value.split('').map(c=>c+c).join(''):value;
  return [0,2,4].map(i=>parseInt(full.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
}
function verify(state, theme, name) {
  assert.equal(state.theme,theme,name); assert.equal(state.bg,theme==='dark'?'rgb(0, 0, 0)':'rgb(255, 255, 255)',name);
  assert.equal(state.color,theme==='dark'?'rgb(255, 255, 255)':'rgb(13, 13, 13)',name);
  assert.equal(state.size,14,name); assert.equal(state.overflow,false,name); assert.deepEqual(state.small,[],name);
  const a=luminance(state.muted), b=luminance(state.surface);
  assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,`secondary text contrast: ${name}`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(output,{recursive:true});
  for (const view of [
    {name:'activity-detail',preload:'activityDetailPreload.js',width:860,height:560,widths:[860,680],groups:'.activity-head,.facts,.diagnosis,.command,.output>div,.timeline ol'},
    {name:'workspace',preload:'workspacePreload.js',width:1000,height:760,widths:[1000,850,700],groups:'.overview,.current-compact,.view-header,.view-actions,.view-tabs,.footer-bar'},
    {name:'approval',preload:'approvalPreload.js',width:680,height:480,widths:[680,480],groups:'header,.approval-actions,.approval-meta'}
  ]) {
    const win=new BrowserWindow({show:false,width:view.width,height:view.height,webPreferences:{preload:path.join(root,'electron',view.preload),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    win.webContents.on('preload-error',(_event,_file,error)=>errors.push(error.message));
    win.webContents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push(details.message);});
    for (const theme of ['dark','light']) {
      await win.loadFile(path.join(root,'renderer',`${view.name}.html`),{query:{theme}});
      if(view.name==='activity-detail') win.webContents.send('activity-detail:payload',fixture);
      await delay(180);
      const state=await win.webContents.executeJavaScript(appearance); verify(state,theme,view.name);
      const layouts=[];
      for (const width of view.widths) {
        win.setContentSize(width,view.height); await delay(100);
        const layout=await win.webContents.executeJavaScript(`(${probeLayout.toString()})(${JSON.stringify(view.groups)})`);
        assert.deepEqual(layout.issues,[],`${view.name}/${theme}/${width}`); assert.equal(layout.bodyOverflow,false);
        assert.ok(layout.scrollbars.length&&layout.scrollbars.every(s=>s.width==='6px'&&s.track==='rgba(0, 0, 0, 0)'&&s.buttons==='none'&&s.nativeWidth==='auto'),'shared custom scrollbars');
        layouts.push({width,layout});
        fs.writeFileSync(path.join(output,`${view.name}-${theme}-${width}-expanded.png`),(await capture(win)).toPNG());
      }
      win.setContentSize(view.width,view.height); await delay(80);
      fs.writeFileSync(path.join(output,`${view.name}-${theme}.png`),(await capture(win)).toPNG());
      const content=await win.webContents.executeJavaScript('document.body.textContent');
      const next=theme==='dark'?'light':'dark'; win.webContents.send('theme:changed',next); await delay(80);
      verify(await win.webContents.executeJavaScript(appearance),next,`${view.name}-live`);
      assert.equal(await win.webContents.executeJavaScript('document.body.textContent'),content,'theme switch must retain payload');
      results.push({view:view.name,theme,state,layouts,liveSwitch:true,payloadRetained:true});
    }
    await win.loadFile(path.join(root,'renderer',`${view.name}.html`),{query:{theme:'system'}});
    const bounds=win.getBounds(); win.setBounds({...bounds,x:-10000,y:-10000}); win.showInactive();
    for (const theme of ['dark','light']) {
      nativeTheme.themeSource=theme; await delay(350);
      win.webContents.send('theme:changed','system'); await delay(80);
      verify(await win.webContents.executeJavaScript(appearance),theme,`${view.name}-system`);
    }
    win.destroy();
  }
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({ok:true,results,systemTheme:true,errors},null,2));
  console.log('Shared theme smoke PASS: auxiliary views, live switching, system switching, typography and contrast'); app.exit(0);
}).catch(error=>{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({ok:false,error:error.stack,results,errors},null,2));console.error(error.stack);app.exit(1);});
