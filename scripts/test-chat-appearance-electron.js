'use strict';
const { app,BrowserWindow,session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ChatViewController } = require('../electron/chatViewController');
const root = path.resolve(__dirname,'..');
const output = path.join(root,'build','chat-appearance-smoke');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'think-tank-chat-appearance-'));
app.setPath('userData',path.join(temporary,'profile'));
app.on('window-all-closed',()=>{});
const pause = ms=>new Promise(resolve=>setTimeout(resolve,ms));
const errors=[],results=[];
let stage='start';
const fail=error=>{fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({ok:false,stage,error:error.stack,results,errors},null,2));console.error(error.stack);app.exit(1);};
process.on('unhandledRejection',fail);
function prepareData() {
  const editor=document.getElementById('prompt-textarea');
  editor.textContent='未发送草稿：保留附件与上下文。';
  const transfer=new DataTransfer();transfer.items.add(new File(['fixture-attachment-bytes'],'示例材料.txt',{type:'text/plain'}));
  const input=document.getElementById('fixtureFile');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  document.getElementById('toolActivity').open=true;
  editor.focus();const range=document.createRange();range.setStart(editor.firstChild,2);range.setEnd(editor.firstChild,7);
  const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
  window.__appearanceRefs={editor,input,file:input.files[0],messages:Array.from(document.querySelectorAll('[data-message-author-role]')),download:document.getElementById('fixtureDownload'),handler:document.getElementById('fixtureDownload').onclick};
  return true;
}
async function readData() {
  const editor=document.getElementById('prompt-textarea'),selection=getSelection();
  return {url:location.href,messages:Array.from(document.querySelectorAll('[data-message-author-role]'),el=>el.outerHTML),
    ids:Array.from(document.querySelectorAll('[data-message-id]'),el=>el.getAttribute('data-message-id')),
    draft:editor.innerHTML,files:await Promise.all(Array.from(document.getElementById('fixtureFile').files,async file=>({name:file.name,size:file.size,text:await file.text()}))),
    toolsOpen:document.getElementById('toolActivity').open,focused:document.activeElement===editor,
    selection:[selection.anchorOffset,selection.focusOffset,selection.toString()]};
}
function readStyle() {
  const editor=document.getElementById('prompt-textarea');
  return {bg:getComputedStyle(document.body).backgroundColor,sidebar:getComputedStyle(document.getElementById('stage-sidebar')).display,
    radius:getComputedStyle(editor.closest('form')).borderRadius,overflow:document.documentElement.scrollWidth>innerWidth,
    sameEditor:window.__appearanceRefs.editor===editor,sameFiles:window.__appearanceRefs.file===document.getElementById('fixtureFile').files[0],
    sameMessages:window.__appearanceRefs.messages.every((el,i)=>el===document.querySelectorAll('[data-message-author-role]')[i]),
    sameDownload:window.__appearanceRefs.handler===document.getElementById('fixtureDownload').onclick};
}
app.whenReady().then(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const webSession=session.fromPartition('persist:chatgpt-session');
  const files={'/chat-native.css':'scripts/fixtures/chat-native.css','/chat-native.js':'scripts/fixtures/chat-native.js','/chat-appearance.js':'renderer/chat-appearance.js','/chat-claude.css':'renderer/chat-claude.css','/scrollbars.css':'renderer/scrollbars.css'};
  webSession.protocol.handle('https',request=>{
    const url=new URL(request.url);
    if(files[url.pathname]) return new Response(fs.readFileSync(path.join(root,files[url.pathname])),{headers:{'Content-Type':url.pathname.endsWith('.css')?'text/css':'text/javascript'}});
    if(url.pathname==='/api/auth/session') return new Response('{}',{headers:{'Content-Type':'application/json'}});
    const html=url.pathname==='/auth/login'?'<main>Isolated authentication page</main>':url.pathname==='/c/unsupported'?'<style>body{background:rgb(45,46,47)}</style><main>Unknown composer layout</main>':fs.readFileSync(path.join(root,'scripts/fixtures/chat-native.html'),'utf8');
    return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"}});
  });
  const config={workspace:temporary,proxyMode:'direct',theme:'dark',experimentalClaudeChat:false};
  const downloads=[];
  const win=new BrowserWindow({show:false,x:-10000,y:-10000,width:1280,height:900,useContentSize:true});
  const controller=new ChatViewController({window:win,toolbarHeight:0,settings:{load:()=>config},log:{info(){},warn(){}},onDownload:item=>downloads.push(item)});
  controller.applyBrowserProxyPolicy=async()=>{};controller.loadHome=async()=>{};
  controller.scheduleMemoryObserver=controller.scheduleStreamObserver=controller.scheduleContinuousMcpMode=()=>{};
  controller.probeLogin=async()=>{};controller.startLoginWatch=()=>{};
  controller.mount();win.showInactive();
  const contents=controller.view.webContents;
  contents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push(details.message);});
  const execute=fn=>contents.executeJavaScript('('+fn.toString()+')()');
  async function capture(name){
    for(let attempt=0;attempt<3;attempt++){
      await pause(150);
      try {
        const image=await contents.capturePage(undefined,{stayHidden:true,stayAwake:true});
        if(image.isEmpty()) throw new Error('Empty capture');
        fs.writeFileSync(path.join(output,name+'.png'),image.toPNG());return;
      } catch(error){
        if(attempt===2||!/UnknownVizError|surface|Empty capture/i.test(error.message)) throw error;
        win.hide();win.showInactive();
      }
    }
  }
  stage='default-off';
  await contents.loadURL('https://chatgpt.com/c/appearance-fixture');await controller.applyChatAppearance();
  assert.equal(await contents.executeJavaScript('document.documentElement.hasAttribute("data-thinktank-chat")'),false);
  await execute(prepareData);const before=await execute(readData);const nativeStyle=await execute(readStyle);
  await capture('native');
  for(const theme of ['dark','light','black']){
    stage='theme-'+theme;config.theme=theme;config.experimentalClaudeChat=true;
    assert.equal((await controller.applyChatAppearance()).active,true);
    assert.deepEqual(await execute(readData),before,'same native data, draft, selection and attachments: '+theme);
    const style=await execute(readStyle);
    assert.equal(style.bg,{dark:'rgb(21, 21, 21)',light:'rgb(252, 252, 251)',black:'rgb(0, 0, 0)'}[theme]);
    assert.equal(style.sidebar,'none');assert.equal(style.radius,'12px');assert.equal(style.overflow,false);
    assert.ok(style.sameEditor&&style.sameFiles&&style.sameMessages&&style.sameDownload);
    await capture('claude-'+theme);results.push({theme,sameData:true,style});
  }
  stage='restore';
  config.experimentalClaudeChat=false;await controller.applyChatAppearance();
  assert.deepEqual(await execute(readData),before);assert.deepEqual(await execute(readStyle),nativeStyle);
  stage='downloads';
  for(const enabled of [false,true]){
    config.experimentalClaudeChat=enabled;await controller.applyChatAppearance();const start=downloads.length;
    await contents.executeJavaScript('document.getElementById("fixtureDownload").click();true',true);
    const deadline=Date.now()+5000;let downloaded;
    while(Date.now()<deadline){downloaded=downloads.slice(start).find(item=>item.status==='completed');if(downloaded)break;await pause(40);}
    assert.ok(downloaded,'download must retain its native click handler');
    assert.equal(fs.readFileSync(downloaded.path,'utf8'),'隔离测试附件：切换外观前后内容一致。');
  }
  stage='native-edit-and-regenerate';
  await execute(()=>{
    const original=document.querySelector('[data-message-author-role=assistant]');
    const replacement=original.cloneNode(true);
    replacement.querySelector('#answerText').textContent='原网页更新后的分支回复：保留新版本内容。';
    original.replaceWith(replacement);
    document.querySelector('[data-message-id=assistant-1]').setAttribute('data-message-id','assistant-branch-2');
    return true;
  });
  const branch=await execute(readData);
  config.experimentalClaudeChat=false;await controller.applyChatAppearance();
  config.experimentalClaudeChat=true;await controller.applyChatAppearance();
  assert.deepEqual(await execute(readData),branch,'native edits and branch changes must not be overwritten by a stale mirror');
  stage='stream-and-send';
  const counts=await contents.executeJavaScript('document.querySelectorAll("[data-message-author-role]").length');
  await contents.executeJavaScript('document.querySelector("[data-testid=send-button]").click();true',true);await pause(80);
  const streaming=await contents.executeJavaScript('window.__streamedMessage=document.querySelector("[data-message-author-role=assistant]:last-child");document.querySelectorAll("[data-message-author-role=assistant]")[1].textContent');
  assert.ok(streaming.length>0);
  config.experimentalClaudeChat=false;await controller.applyChatAppearance();
  config.experimentalClaudeChat=true;await controller.applyChatAppearance();
  await pause(120);
  assert.equal(await contents.executeJavaScript('document.querySelectorAll("[data-message-author-role]").length'),counts+2,'style switch must not resubmit a prompt');
  assert.equal(await contents.executeJavaScript('Array.from(document.querySelectorAll("[data-message-author-role=user]")).at(-1).textContent'),before.draft);
  assert.equal(await contents.executeJavaScript('document.getElementById("fixtureFile").files[0].name'),'示例材料.txt');
  assert.equal(await controller.stopGeneration(),true,'native stop-generation button still works');
  const stopped=await contents.executeJavaScript('Array.from(document.querySelectorAll("[data-message-author-role=assistant]")).at(-1).textContent');await pause(120);
  assert.equal(await contents.executeJavaScript('Array.from(document.querySelectorAll("[data-message-author-role=assistant]")).at(-1).textContent'),stopped);
  stage='navigation';
  await contents.loadURL('https://chatgpt.com/c/next-conversation');await controller.applyChatAppearance();
  assert.equal(controller.chatAppearance.active,true);
  assert.equal(await contents.executeJavaScript('document.querySelectorAll("[data-message-author-role]").length'),2,'new route must show only its own native messages');
  await contents.loadURL('https://chatgpt.com/auth/login');await controller.applyChatAppearance();
  assert.equal(controller.chatAppearance.active,false);
  assert.equal(await contents.executeJavaScript('document.documentElement.hasAttribute("data-thinktank-chat")'),false);
  await contents.loadURL('https://chatgpt.com/c/unsupported');await controller.applyChatAppearance();
  assert.equal(controller.chatAppearance.active,false);
  assert.equal(await contents.executeJavaScript('getComputedStyle(document.body).backgroundColor'),'rgb(45, 46, 47)','unrecognized composer keeps native presentation');
  assert.deepEqual(errors,[]);
  stage='shutdown-with-pending-style';
  await contents.loadURL('https://chatgpt.com/c/shutdown-fixture');await controller.applyChatAppearance();
  await contents.executeJavaScript('setTimeout(()=>{const end=Date.now()+20000;while(Date.now()<end){}},10);true');
  await pause(80);
  const pending=controller.applyChatAppearance();await pause(30);
  const shutdownStarted=Date.now();controller.dispose();win.destroy();
  let timer;
  try { await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('pending appearance did not settle after shutdown')),1500);})]); }
  finally { clearTimeout(timer); }
  const shutdownMs=Date.now()-shutdownStarted;
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({ok:true,results,defaultOff:true,restored:true,downloads:2,nativeBranchRetained:true,streamingRetained:true,noDuplicateSend:true,nativeStop:true,navigationIsolated:true,unsupportedFallback:true,busyShutdownMs:shutdownMs,errors},null,2));
  console.log('Chat appearance PASS: native DOM identity, messages, draft, selection, files, streaming, downloads, navigation and fallback');app.exit(0);
}).catch(fail);
