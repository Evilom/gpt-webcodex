const test=require('node:test');
const assert=require('node:assert/strict');
const {ChatReplica}=require('../electron/chatReplica');
const {DEFAULTS,normalize}=require('../electron/services/config');
function fixture(){
  let url='https://chatgpt.com/c/one';
  const events=[],scripts=[];
  const data={supported:true,url,sourceId:'page-1',revision:1,running:false,messages:[{id:'one',role:'assistant',html:'<p>one</p>'}]};
  const contents={getURL:()=>url,isDestroyed:()=>false,executeJavaScript:async script=>{scripts.push(script);return data;}};
  const replica=new ChatReplica({contents:()=>contents,eligible:value=>value.startsWith('https://chatgpt.com/c/'),onChange:state=>events.push(state)});
  return {replica,contents,data,events,scripts,url:value=>{url=value;}};
}
test('independent renderer defaults off, does no page work, and waits for a matching render acknowledgement',async()=>{
  assert.equal(DEFAULTS.experimentalIndependentChat,false);
  for(const value of [undefined,'true',1,null])assert.equal(normalize({experimentalIndependentChat:value}).experimentalIndependentChat,false);
  const f=fixture();f.replica.configure(false);f.replica.sample();assert.equal(f.scripts.length,0);
  f.replica.configure(true);await f.replica.sample();
  assert.equal(f.replica.state.active,false);assert.equal(f.replica.acknowledge('wrong'),false);
  assert.equal(f.replica.acknowledge(f.replica.state.token),true);assert.equal(f.replica.state.active,true);
  assert.equal('snapshot' in f.replica.summary(),false);
  f.replica.configure(false);assert.equal(f.replica.state.snapshot,null);assert.equal(f.replica.state.active,false);
  f.replica.dispose();
});
test('late snapshots and acknowledgements cannot cross navigation or disabling',async()=>{
  const f=fixture();let finish;
  f.contents.executeJavaScript=()=>new Promise(resolve=>{finish=resolve;});
  f.replica.configure(true);const pending=f.replica.sample();await Promise.resolve();
  f.url('https://chatgpt.com/c/two');f.replica.reset();finish(f.data);await pending;
  assert.equal(f.replica.state.snapshot,null);assert.equal(f.replica.acknowledge('1'),false);
  f.replica.dispose();
});
test('unknown pages and structures preserve the native page and clear stale content',async()=>{
  const f=fixture();f.replica.configure(true);await f.replica.sample();f.replica.acknowledge(f.replica.state.token);
  f.url('https://auth.openai.com/login');f.replica.sample();
  assert.equal(f.replica.state.active,false);assert.equal(f.replica.state.snapshot,null);
  f.url(f.data.url);f.data.supported=false;await f.replica.sample();assert.equal(f.replica.state.status,'unavailable');
  f.replica.dispose();
});
test('message limits and roles are checked and unchanged snapshots do not replace messages',async()=>{
  const f=fixture();f.data.messages=[{id:'system',role:'system',html:'private'},...Array.from({length:110},(_,i)=>({id:String(i),role:'assistant',html:'x'.repeat(30000)}))];
  f.replica.configure(true);await f.replica.sample();
  assert.equal(f.replica.state.snapshot.messages.length,100);
  assert.ok(f.replica.state.snapshot.messages.reduce((n,m)=>n+m.html.length,0)<=240000);
  const snapshot=f.replica.state.snapshot;
  f.data.unchanged=true;await f.replica.sample();assert.equal(f.replica.state.snapshot,snapshot);
  f.data.running=true;await f.replica.sample();assert.equal(f.replica.state.snapshot.running,true);
  f.replica.dispose();
});
test('an unresponsive page falls back without overlapping reads or blocking disable/dispose',async()=>{
  const f=fixture();let count=0;
  f.contents.executeJavaScript=()=>{count++;return new Promise(()=>{});};
  f.replica.configure(true);f.replica.sample();await Promise.resolve();
  await new Promise(resolve=>setTimeout(resolve,2600));
  assert.equal(f.replica.state.status,'waiting');assert.equal(f.replica.state.active,false);
  f.replica.sample();assert.equal(count,1);
  const start=Date.now();f.replica.configure(false);f.replica.dispose();assert.ok(Date.now()-start<100);
});
test('native actions require an enabled acknowledged exact conversation and validate draft sizes',async()=>{
  const f=fixture(),request={id:'send-1',kind:'send',url:f.data.url,sourceId:f.data.sourceId,expected:'draft'};
  assert.equal((await f.replica.action(request)).ok,false);
  f.replica.configure(true);await f.replica.sample();assert.equal((await f.replica.action(request)).ok,false);
  f.replica.acknowledge(f.replica.state.token);
  for(const bad of [{sourceId:'other'},{url:'https://chatgpt.com/c/elsewhere'},{kind:'arbitrary-js'},{expected:'x'.repeat(100001)}])assert.equal((await f.replica.action({...request,...bad})).ok,false);
  f.replica.dispose();
});
test('identical action retries share one execution and conflicting or concurrent actions are refused',async()=>{
  const f=fixture();f.replica.configure(true);await f.replica.sample();f.replica.acknowledge(f.replica.state.token);
  let resolve,count=0;f.contents.executeJavaScript=()=>{count++;return new Promise(done=>{resolve=done;});};
  const request={id:'send-once',kind:'send',url:f.data.url,sourceId:f.data.sourceId,expected:'draft'};
  const first=f.replica.action(request),second=f.replica.action(request);
  assert.equal((await f.replica.action({...request,expected:'different'})).ok,false);
  assert.equal((await f.replica.action({...request,id:'another'})).ok,false);
  assert.equal(count,1);resolve({ok:true});assert.deepEqual(await first,await second);
  assert.equal((await f.replica.action(request)).ok,true);assert.equal(count,1);
  f.replica.dispose();
});
test('late action results never apply to a newly selected conversation',async()=>{
  const f=fixture();f.replica.configure(true);await f.replica.sample();f.replica.acknowledge(f.replica.state.token);
  let resolve;f.contents.executeJavaScript=()=>new Promise(done=>{resolve=done;});
  const result=f.replica.action({id:'late',kind:'stop',url:f.data.url,sourceId:f.data.sourceId});
  f.url('https://chatgpt.com/c/two');f.replica.reset();resolve({ok:true});
  assert.equal((await result).ok,false);assert.equal(f.replica.state.snapshot,null);f.replica.dispose();
});
