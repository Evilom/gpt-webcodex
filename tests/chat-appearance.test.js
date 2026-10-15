const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatViewController } = require('../electron/chatViewController');
const { normalize, DEFAULTS } = require('../electron/services/config');

function fixture() {
  const config = { theme:'black',experimentalClaudeChat:false };
  const calls = { insert:0,remove:[],execute:[] };
  let url = 'https://chatgpt.com/c/appearance-test';
  const contents = {
    isDestroyed:()=>false,getURL:()=>url,
    insertCSS:async()=> 'style-'+(++calls.insert),
    removeInsertedCSS:async key=>{calls.remove.push(key);},
    executeJavaScript:async script=>{calls.execute.push(script);return {active:true,supported:true};}
  };
  const controller = new ChatViewController({settings:{load:()=>config},log:{warn(){},info(){}}});
  controller.view={webContents:contents};controller.emitState=()=>{};
  return {controller,config,calls,contents,setUrl:value=>{url=value;}};
}

test('experimental conversation appearance defaults off and accepts only an explicit boolean', () => {
  assert.equal(DEFAULTS.experimentalClaudeChat,false);
  for (const value of [undefined,'true',1,null]) assert.equal(normalize({experimentalClaudeChat:value}).experimentalClaudeChat,false);
  assert.equal(normalize({...DEFAULTS,experimentalClaudeChat:true}).experimentalClaudeChat,true);
});

test('disabled appearance leaves an untouched webpage alone; disabling removes only its own stylesheet', async () => {
  const f=fixture();await f.controller.applyChatAppearance();
  assert.equal(f.calls.insert,0);assert.deepEqual(f.calls.execute,[]);
  f.config.experimentalClaudeChat=true;
  assert.equal((await f.controller.applyChatAppearance()).active,true);
  await f.controller.applyChatAppearance();
  assert.equal(f.calls.insert,1,'same document must not accumulate styles');
  f.config.experimentalClaudeChat=false;
  assert.equal((await f.controller.applyChatAppearance()).active,false);
  assert.deepEqual(f.calls.remove,['style-1']);
});

test('appearance injection excludes authentication, insecure and unrelated pages', async () => {
  const f=fixture();f.config.experimentalClaudeChat=true;
  for (const url of ['https://auth.openai.com/','https://accounts.google.com/','https://chatgpt.com/auth/login','http://chatgpt.com/c/x','https://chatgpt.com.example.org/c/x']) {
    f.setUrl(url);assert.equal((await f.controller.applyChatAppearance()).active,false);
  }
  assert.equal(f.calls.insert,0);assert.deepEqual(f.calls.execute,[]);
});

test('navigation during style insertion discards the old document key and applies to the next document', async () => {
  const f=fixture();f.config.experimentalClaudeChat=true;
  let ready,release;
  const started=new Promise(resolve=>{ready=resolve;});
  f.contents.insertCSS=async()=>{f.calls.insert++;if(f.calls.insert===1){ready();await new Promise(resolve=>{release=resolve;});}return 'style-'+f.calls.insert;};
  const first=f.controller.applyChatAppearance();await started;
  f.controller.chatAppearanceDocument++;f.setUrl('https://chatgpt.com/c/new-conversation');
  const next=f.controller.applyChatAppearance();release();await first;await next;
  assert.deepEqual(f.calls.remove,['style-1']);assert.equal(f.calls.insert,2);
  assert.equal(f.calls.execute.length,1);assert.ok(f.calls.execute[0].includes('/c/new-conversation'));
});

test('rapid disable wins after a pending enable; an insertion failure falls back without reloading', async () => {
  const f=fixture();f.config.experimentalClaudeChat=true;
  let ready,release;
  const started=new Promise(resolve=>{ready=resolve;});
  f.contents.insertCSS=async()=>{ready();await new Promise(resolve=>{release=resolve;});return 'pending-style';};
  const first=f.controller.applyChatAppearance();await started;
  f.config.experimentalClaudeChat=false;const last=f.controller.applyChatAppearance();release();await first;await last;
  assert.equal(f.controller.chatAppearance.enabled,false);assert.deepEqual(f.calls.remove,['pending-style']);
  f.config.experimentalClaudeChat=true;f.contents.insertCSS=async()=>{throw new Error('fixture insertion failure');};
  assert.equal((await f.controller.applyChatAppearance()).active,false);
  assert.equal(f.controller.chatAppearance.enabled,true);
});

test('an unresponsive page returns a pending preference instead of holding the UI indefinitely', async () => {
  const f=fixture();f.config.experimentalClaudeChat=true;
  f.contents.executeJavaScript=()=>new Promise(()=>{});
  const started=Date.now();const result=await f.controller.applyChatAppearance();
  assert.equal(result.pending,true);assert.equal(result.enabled,true);
  assert.ok(Date.now()-started<4000);
  const pending=f.controller.applyChatAppearance();
  f.controller.chatAppearanceAbort.abort();
  assert.equal((await pending).pending,false,'shutdown releases the pending caller');
});
