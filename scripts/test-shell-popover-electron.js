'use strict';
const electron = require('electron');
const { app,BrowserWindow,WebContentsView,ipcMain } = electron;
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { ChatViewController } = require('../electron/chatViewController');
const root = path.resolve(__dirname,'..');
const scale = Number(process.env.SHELL_SMOKE_SCALE || 1);
if (scale !== 1) app.commandLine.appendSwitch('force-device-scale-factor',String(scale));
const output = path.join(root,'build',scale === 1 ? 'shell-popover-smoke' : `shell-popover-smoke-${scale}`);
fs.mkdirSync(output,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'think-tank-popover-')));
app.on('window-all-closed',()=>{});
const delay = ms=>new Promise(resolve=>setTimeout(resolve,ms));
const errors=[],results=[];
let server,stage='start';
let diagnostic=()=>({});
process.on('exit',()=>server?.kill());
async function until(check) {
  const end=Date.now()+7000;
  while (Date.now()<end) { if (await check()) return; await delay(30); }
  throw new Error('Timeout: '+stage+' '+JSON.stringify(diagnostic()));
}
function startPreview() {
  return new Promise((resolve,reject)=>{
    server=spawn(process.execPath,[path.join(__dirname,'shell-preview-server.js')],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',SHELL_PREVIEW_PORT:'0'},stdio:['ignore','pipe','pipe']});
    server.once('error',reject);
    server.stdout.on('data',data=>{const match=String(data).match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});
    server.once('exit',()=>reject(new Error('preview exited')));
  });
}
// Keep every test surface offscreen and non-activating. Only display work-area
// coordinates and activation are substituted; the windows, IPC and views are real.
const exported = {exports:{}};
vm.runInNewContext(fs.readFileSync(path.join(root,'electron/shellPopover.js'),'utf8'),{
  module:exported,__dirname:path.join(root,'electron'),setImmediate,
  require:name=>name === 'electron' ? {...electron,
    screen:{getDisplayMatching:()=>({workArea:{x:-20000,y:-20000,width:20000,height:20000}})},
    BrowserWindow:function(options) {
      const win=new BrowserWindow({...options,focusable:false});
      win.webContents.on('console-message',details=>{if(details.level==='error')errors.push('popover: '+details.message);});
      win.show=()=>win.showInactive(); return win;
    }
  } : require(name)
});
const { ShellPopover }=exported.exports;
app.whenReady().then(async()=>{
  const url=await startPreview();
  const host=new BrowserWindow({show:false,frame:false,thickFrame:false,useContentSize:true,x:-10000,y:-10000,width:1440,height:900,webPreferences:{preload:path.join(__dirname,'fixtures/shell-popover-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  host.showInactive();
  // A non-activating offscreen fixture has no OS focus. Model the owning host
  // as focused, while explicit native-focus/outside/layout events remain real.
  host.isFocused=()=>true;
  host.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});
  const controller=new ChatViewController({window:host,toolbarHeight:56});
  const native=new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  controller.view=native;host.contentView.addChildView(native);
  native.webContents.on('console-message',details=>{if(details.level==='error')errors.push('native: '+details.message);});
  await native.webContents.loadURL(url+'/mock-chat.html?native=1&theme=black');
  await native.webContents.executeJavaScript(`document.getElementById('prompt-textarea').textContent='不丢失的原生草稿';document.getElementById('toolActivity').open=true;window.originalMessage=document.querySelector('[data-message-id]');true;`);
  const nativeData=()=>native.webContents.executeJavaScript(`({draft:document.getElementById('prompt-textarea').textContent,tools:document.getElementById('toolActivity').open,message:document.querySelector('[data-message-id]').outerHTML,same:window.originalMessage===document.querySelector('[data-message-id]')})`);
  const original=await nativeData();
  const popover=new ShellPopover(host);
  const closed=[],close=popover.close.bind(popover);
  popover.close=reason=>{closed.push(reason);return close(reason);};
  diagnostic=()=>({hostVisible:host.isVisible(),current:popover.current?.key,popupVisible:popover.window?.isVisible(),popupUrl:popover.window?.webContents.getURL(),closed:closed.slice(-8)});
  // macOS may focus the native view when showing a non-activating child. The
  // fixture controls activation; explicit clicks still exercise focus dismissal.
  native.webContents.on('focus',event=>{if(event?.fixtureClick)popover.close('outside');});
  ipcMain.handle('test:popover-update',(event,payload)=>{
    assert.equal(event.sender,host.webContents);assert.equal(event.senderFrame,event.sender.mainFrame);
    return popover.update(payload);
  });
  ipcMain.handle('test:popover-insets',(_event,insets)=>{controller.setContentInsets(insets);return true;});
  const settle=()=>host.webContents.executeJavaScript(`(async()=>{for(const a of document.getAnimations())if(Number.isFinite(a.effect.getComputedTiming().endTime)&&a.playState==='running')a.finish();syncChatContentInsets();await new Promise(r=>setTimeout(r,80));})()`);
  const click=id=>host.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`);
  const waitOpen=key=>until(()=>popover.current?.key===key&&popover.window?.isVisible());
  for(const width of [1440,640])for(const theme of ['light','dark','black'])for(const workbench of [0,1]) {
    stage=`${width}/${theme}/${workbench}`;
    host.setContentSize(width,720);
    await host.loadURL(`${url}/?theme=${theme}&scenario=chat-skin&workbench=${workbench}`);
    await host.webContents.insertCSS('#previewChat{visibility:hidden!important}');
    await settle();
    const before=native.getBounds();
    const panels=await host.webContents.executeJavaScript(`JSON.stringify(['studioSidebar','workbench','shellFooter'].map(id=>document.getElementById(id).getBoundingClientRect().toJSON()))`);
    await click('moreButton');await waitOpen('more');
    await delay(150);
    assert.deepEqual(native.getBounds(),before,'More must not resize native ChatGPT');
    assert.equal(await host.webContents.executeJavaScript(`JSON.stringify(['studioSidebar','workbench','shellFooter'].map(id=>document.getElementById(id).getBoundingClientRect().toJSON()))`),panels);
    assert.equal(popover.window.getParentWindow(),host);
    const styles=await popover.window.webContents.executeJavaScript(`(()=>{const el=document.getElementById('moreMenu'),r=el.getBoundingClientRect();return {width:r.width,height:r.height,within:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,bg:getComputedStyle(el).backgroundColor,hidden:el.hidden,inert:el.inert};})()`);
    assert.ok(styles.within&&!styles.hidden&&!styles.inert);
    assert.equal(styles.bg,theme==='black'?'rgb(0, 0, 0)':theme==='dark'?'rgb(26, 26, 25)':'rgb(255, 255, 255)');
    if(width===1440&&theme==='black'&&!workbench) {
      const image=await popover.window.capturePage();
      assert.equal(image.isEmpty(),false);
      fs.writeFileSync(path.join(output,'native-more-black.png'),image.toPNG());
    }
    const bounds=popover.window.getBounds(),content=host.getContentBounds();
    assert.ok(bounds.x>=content.x&&bounds.y>=content.y&&bounds.x+bounds.width<=content.x+content.width&&bounds.y+bounds.height<=content.y+content.height);
    await popover.window.webContents.executeJavaScript(`document.getElementById('chatAppearanceToggle').click()`);
    await until(()=>host.webContents.executeJavaScript(`document.getElementById('chatAppearanceToggle').checked&&!document.getElementById('chatAppearanceToggle').disabled`));
    await until(()=>popover.window.webContents.executeJavaScript(`document.getElementById('chatAppearanceToggle').checked&&!document.getElementById('chatAppearanceToggle').disabled`));
    assert.deepEqual(native.getBounds(),before);
    await host.webContents.executeJavaScript(`window.updateCalls=0;window.browserAssistant.checkUpdate=()=>{window.updateCalls++;return Promise.resolve({ok:true,data:{stage:'current',current:'0.9.15'}})};true;`);
    await popover.window.webContents.executeJavaScript(`document.getElementById('checkUpdate').click()`);
    await until(()=>host.webContents.executeJavaScript('window.updateCalls===1'));
    assert.ok(popover.window.isVisible());
    await popover.window.webContents.executeJavaScript(`window.shellPopover.send({type:'action',token:${JSON.stringify(popover.current.token)},id:'stopTask',kind:'click'})`);
    assert.deepEqual(await nativeData(),original);
    await popover.window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await until(()=>!popover.current);
    assert.equal(await host.webContents.executeJavaScript('document.activeElement.id'),'moreButton');
    assert.equal(await host.webContents.executeJavaScript(`document.getElementById('workbench').hidden`),!workbench);
    await click('openTaskHistoryButton');await waitOpen('history');
    assert.deepEqual(native.getBounds(),before,'History must not resize native ChatGPT');
    await host.webContents.executeJavaScript(`window.historyCalls=0;window.browserAssistant.taskHistory=()=>{window.historyCalls++;return Promise.resolve({ok:true,data:{items:[]}})};true;`);
    await popover.window.webContents.executeJavaScript(`document.getElementById('refreshTaskHistoryBtn').click()`);
    await until(()=>host.webContents.executeJavaScript('window.historyCalls===1'));
    assert.ok(popover.window.isVisible());
    native.webContents.emit('focus',{fixtureClick:true});await until(()=>!popover.current);
    assert.deepEqual(native.getBounds(),before);
    results.push({width,theme,workbench,bounds:before,popup:bounds,styles});
  }
  stage='stream-and-dismiss';
  await native.webContents.executeJavaScript(`document.getElementById('fixtureStream').click()`);
  await click('moreButton');await waitOpen('more');
  const started=await native.webContents.executeJavaScript(`document.querySelector('#thread').lastElementChild.textContent`);
  await delay(200);
  const stream=await native.webContents.executeJavaScript(`document.querySelector('#thread').lastElementChild.textContent`);
  assert.notEqual(stream,started);
  host.setContentSize(700,720);await until(()=>!popover.current);
  await settle();await click('moreButton');await waitOpen('more');
  await host.webContents.executeJavaScript(`document.getElementById('studioTaskGroup').click()`);
  await until(()=>!popover.current);
  stage='long-content';
  await host.webContents.executeJavaScript(`window.browserAssistant.taskHistory=()=>Promise.resolve({ok:true,data:{items:Array.from({length:50},(_,i)=>({task_id:'history-'+i,status:'failed',objective:'历史任务 '+i+'：'+ '连续长标题'.repeat(30),failure:'E:/'+ 'long-path/'.repeat(80)}))}});true;`);
  await click('openTaskHistoryButton');await waitOpen('history');
  await until(()=>popover.window.webContents.executeJavaScript(`document.querySelectorAll('.task-history-row').length===50`));
  const longHistory=await popover.window.webContents.executeJavaScript(`(()=>{const el=document.getElementById('taskHistoryPopover');el.scrollTop=100;return {height:el.getBoundingClientRect().height,scrolls:el.scrollHeight>el.clientHeight&&el.scrollTop>0,horizontal:el.scrollWidth>el.clientWidth+1,within:el.getBoundingClientRect().bottom<=innerHeight}})()`);
  assert.ok(longHistory.height<=420&&longHistory.scrolls&&longHistory.within&&!longHistory.horizontal,JSON.stringify(longHistory));
  await click('moreButton');await waitOpen('more');
  assert.equal(await host.webContents.executeJavaScript(`document.getElementById('taskHistoryPopover').hidden`),true);
  await host.webContents.executeJavaScript(`document.getElementById('updateStatus').textContent='更新状态：'+ '这是一段较长的更新说明。'.repeat(80);document.getElementById('updateAction').hidden=false;`);
  await until(()=>popover.window.webContents.executeJavaScript(`document.getElementById('updateStatus').textContent.length>500&&!document.getElementById('updateAction').hidden`));
  const longMenu=await popover.window.webContents.executeJavaScript(`(()=>{const el=document.getElementById('moreMenu');return {height:el.getBoundingClientRect().height,scrolls:el.scrollHeight>el.clientHeight,within:el.getBoundingClientRect().bottom<=innerHeight}})()`);
  assert.ok(longMenu.height<=480&&longMenu.scrolls&&longMenu.within);
  await popover.window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));true;`);
  assert.equal(await popover.window.webContents.executeJavaScript('document.activeElement.id'),'updateAction');
  await popover.window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));true;`);
  await until(()=>!popover.current);
  stage='cancel-pending-open';
  const late=new ShellPopover(host);
  const pending=late.update({key:'more',token:'late',theme:'black',html:'<div>late</div>',bounds:{x:10,y:10,width:280,height:100}});
  late.close('outside');await pending;await delay(100);
  assert.equal(late.current,null);assert.equal(late.window.isVisible(),false);
  late.dispose();popover.dispose();controller.dispose();host.destroy();
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({ok:true,scale,results,longHistory,longMenu,streamContinued:true,cancelPending:true,errors},null,2));
  app.exit(0);
}).catch(error=>{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({ok:false,stage,error:error.stack,results,errors},null,2));console.error(error.stack);app.exit(1);});
