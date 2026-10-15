const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ deferred = false, hostBounds = {x:1600,y:800,width:640,height:480} } = {}) {
  const ipcMain = new EventEmitter();
  const events = [], windows = [];
  let finishLoad;
  class Window extends EventEmitter {
    constructor(options = {}) {
      super(); this.options = options; this.visible = false; this.destroyed = false;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.send = (channel,payload)=>events.push({channel,payload});
      this.webContents.isDestroyed = ()=>this.destroyed;
      this.webContents.focus = ()=>{this.focused=true;};
      this.webContents.setWindowOpenHandler = handler=>{this.openHandler=handler;};
      windows.push(this);
    }
    removeMenu() {}
    loadFile() { return deferred ? new Promise(resolve=>{finishLoad=resolve;}) : Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isFocused() { return true; }
    getContentBounds() { return hostBounds; }
    setBounds(bounds) { this.bounds=bounds; }
    show() { this.visible=true; }
    hide() { this.visible=false; }
    destroy() { this.destroyed=true;this.emit('closed'); }
  }
  const exported = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/shellPopover.js'),'utf8'),{
    module:exported,__dirname:__dirname,require:name=>name==='electron'?{
      BrowserWindow:Window,ipcMain,screen:{getDisplayMatching:()=>({workArea:{x:0,y:0,width:1920,height:1080}})}
    }:require(name),setImmediate
  });
  const host=new Window();host.visible=true;
  const panel=new exported.exports.ShellPopover(host);
  const payload={key:'more',token:'one',theme:'black',html:'<div>owned panel</div>',bounds:{x:600,y:400,width:296,height:300}};
  const emit=(data,sender=panel.window?.webContents,frame=sender?.mainFrame)=>ipcMain.emit('shell-popover:event',{sender,senderFrame:frame},data);
  return {panel,host,windows,events,payload,emit,ipcMain,finish:()=>finishLoad()};
}

test('native panel fits the visible host/work area and accepts only its own main-frame actions',async()=>{
  const f=fixture();await f.panel.update(f.payload);
  assert.deepEqual(JSON.parse(JSON.stringify(f.panel.window.bounds)),{x:1624,y:800,width:296,height:280});
  f.emit({type:'ready',token:'one'},f.host.webContents);
  assert.equal(f.panel.window.isVisible(),false);
  f.emit({type:'ready',token:'one'});assert.equal(f.panel.window.isVisible(),true);
  const count=f.events.length;
  f.emit({type:'action',token:'one',id:'checkUpdate'},f.host.webContents);
  f.emit({type:'action',token:'old',id:'checkUpdate'});
  f.emit({type:'action',token:'one',id:'checkUpdate'},f.panel.window.webContents,{});
  assert.equal(f.events.length,count);
  f.emit({type:'action',token:'one',id:'checkUpdate',kind:'click'});
  assert.equal(f.events.at(-1).payload.key,'more');
  f.emit({type:'close',token:'one'});
  assert.equal(f.panel.window.isVisible(),false);
  assert.equal(f.events.at(-1).payload.reason,'escape');
  assert.equal(f.host.focused,true);
  f.panel.dispose();assert.equal(f.ipcMain.listenerCount('shell-popover:event'),0);
});

test('dismiss while loading prevents late reopening and layout changes dismiss without focus theft',async()=>{
  const f=fixture({deferred:true});
  const pending=f.panel.update(f.payload);f.panel.close();f.finish();await pending;
  f.emit({type:'ready',token:'one'});assert.equal(f.panel.window.isVisible(),false);
  await f.panel.update({...f.payload,token:'two'});
  f.emit({type:'ready',token:'two'});assert.equal(f.panel.window.isVisible(),true);
  f.host.emit('resize');assert.equal(f.panel.window.isVisible(),false);
  assert.equal(f.host.focused,undefined);
  await f.panel.update({...f.payload,token:'three'});
  f.emit({type:'ready',token:'three'});f.host.webContents.emit('did-start-navigation');
  assert.equal(f.panel.window.isVisible(),false);
  f.panel.dispose();
});

test('destroyed or crashed panels close their source state and can reopen',async()=>{
  const f=fixture();await f.panel.update(f.payload);
  f.panel.window.webContents.emit('render-process-gone');
  assert.equal(f.panel.current,null);assert.equal(f.panel.window,null);
  await f.panel.update({...f.payload,token:'two'});
  f.emit({type:'ready',token:'two'});assert.equal(f.panel.window.isVisible(),true);
  assert.equal(f.panel.window.openHandler().action,'deny');
  let blocked=false;f.panel.window.webContents.emit('will-navigate',{preventDefault:()=>{blocked=true;}});assert.ok(blocked);
  f.panel.dispose();assert.equal(f.panel.window,null);
});

test('invalid panels and hosts outside the display never open a stranded popup',async()=>{
  const f=fixture({hostBounds:{x:-5000,y:-5000,width:640,height:480}});
  await assert.rejects(f.panel.update({...f.payload,key:'unowned'}));
  await assert.rejects(f.panel.update({...f.payload,html:'x'.repeat(524289)}));
  await f.panel.update(f.payload);
  assert.equal(f.panel.current,null);assert.equal(f.panel.window.isVisible(),false);
  f.panel.dispose();
});

test('disposing after the parent closes never accesses destroyed web contents',async()=>{
  const f=fixture();await f.panel.update(f.payload);
  f.host.destroy();
  Object.defineProperty(f.host,'webContents',{get(){throw new TypeError('Object has been destroyed');}});
  assert.doesNotThrow(()=>f.panel.dispose());
  assert.equal(f.panel.window,null);
  assert.equal(f.ipcMain.listenerCount('shell-popover:event'),0);
});
