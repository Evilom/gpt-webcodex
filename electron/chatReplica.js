const { readConversationDocument,performConversationAction } = require('../renderer/chat-replica-source');

class ChatReplica {
  constructor({ contents, eligible, onChange, chooseFiles }) {
    this.contents = contents;
    this.eligible = eligible;
    this.onChange = onChange;
    this.chooseFiles = chooseFiles;
    this.actions = new Map();
    this.state = { enabled:false,active:false,status:'off',message:'默认关闭；原网页继续负责会话与操作',snapshot:null,token:'' };
    this.epoch = 0;
    this.sequence = 0;
    this.revision = -1;
    this.pending = false;
    this.disposed = false;
  }

  publish(patch) {
    if (this.disposed) return;
    if (Object.entries(patch).every(([key,value])=>this.state[key]===value)) return;
    this.state = { ...this.state,...patch };
    this.onChange(this.state);
  }

  configure(enabled) {
    if (this.disposed) return;
    if (this.state.enabled === enabled) { if (enabled) this.schedule(0); return; }
    const previous = this.state.enabled;
    this.reset();
    this.publish({enabled,status:enabled?'loading':'off',message:enabled?'正在准备独立视图；原网页保持运行':'已返回原网页，实验视图已关闭'});
    if (enabled) this.schedule(0);
    else if (previous) this.cleanup();
  }

  reset() {
    this.epoch++;
    this.revision = -1;
    clearTimeout(this.timer);
    clearTimeout(this.deadline);
    this.publish({active:false,snapshot:null,token:'',status:this.state.enabled?'loading':'off'});
  }

  schedule(delay = 1000) {
    if (this.disposed || !this.state.enabled || this.pending) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sample(),delay);
    this.timer.unref?.();
  }

  sample() {
    if (this.disposed || !this.state.enabled || this.pending) return;
    const contents = this.contents();
    const url = contents && !contents.isDestroyed() ? contents.getURL() : '';
    if (!url || !this.eligible(url)) {
      this.publish({active:false,snapshot:null,token:'',status:'unavailable',message:'此页面暂不支持独立显示，已保留原网页'});
      this.schedule();
      return;
    }
    const epoch = this.epoch;
    this.pending = true;
    const current = () => !this.disposed && this.state.enabled && epoch === this.epoch && !contents.isDestroyed() && contents.getURL() === url && this.eligible(url);
    this.deadline = setTimeout(() => {
      if (current()) this.publish({active:false,snapshot:null,token:'',status:'waiting',message:'网页暂时未响应，已返回原网页；不会重复读取或发送消息'});
    },2500);
    this.deadline.unref?.();
    this.inFlight = Promise.resolve().then(() => contents.executeJavaScript(`(${readConversationDocument.toString()})(${JSON.stringify({url,revision:this.revision})})`)).then(result => {
      if (!current()) { if (!this.state.enabled) this.cleanup(); return; }
      if (!result?.supported || result.url !== url || !Number.isSafeInteger(result.revision)) {
        this.revision = -1;
        this.publish({active:false,snapshot:null,token:'',status:result?.settling?'loading':'unavailable',message:result?.settling?'正在等待新会话内容，原网页保持显示':'网页结构暂不匹配，已返回原网页'});
        return;
      }
      if (result.unchanged && this.state.snapshot) {
        if (this.state.snapshot.running !== Boolean(result.running) || JSON.stringify(this.state.snapshot.composer)!==JSON.stringify(result.composer)) this.publish({snapshot:{...this.state.snapshot,running:Boolean(result.running),composer:result.composer},token:String(++this.sequence)});
        return;
      }
      if (!Array.isArray(result.messages)) { this.revision = -1; return; }
      this.revision = result.revision;
      let budget = 240000,truncated=Boolean(result.truncated)||result.messages.length>100;
      const messages = result.messages.slice(-100).filter(message=>['user','assistant'].includes(message.role)&&typeof message.id==='string'&&typeof message.html==='string').map(message=>{
        const html=message.html.slice(0,Math.max(0,Math.min(24000,budget)));budget-=html.length;
        if(html.length!==message.html.length)truncated=true;
        return {id:message.id.slice(0,240),role:message.role,html};
      });
      const snapshot = {url,sourceId:result.sourceId,revision:result.revision,messages,running:Boolean(result.running),truncated,composer:result.composer};
      const remounted=this.state.snapshot?.sourceId&&this.state.snapshot.sourceId!==snapshot.sourceId;
      this.publish({snapshot,...(remounted?{active:false}:{}),token:String(++this.sequence),status:'ready',message:'独立渲染实验 · 与原网页共用会话、草稿和附件'});
    }).catch(() => {
      if (current()) this.publish({active:false,snapshot:null,token:'',status:'unavailable',message:'独立视图读取失败，已返回原网页'});
    }).finally(() => {
      clearTimeout(this.deadline);
      this.pending = false;
      this.schedule();
    });
    return this.inFlight;
  }

  acknowledge(token) {
    const contents = this.contents();
    if (this.disposed || !this.state.enabled || !this.state.snapshot || token !== this.state.token
      || !contents || contents.isDestroyed() || contents.getURL() !== this.state.snapshot.url || !this.eligible(contents.getURL())) return false;
    if (!this.state.active) this.publish({active:true});
    return true;
  }

  async action(request) {
    const contents=this.contents(),snapshot=this.state.snapshot;
    const valid=()=>!this.disposed&&this.state.enabled&&this.state.active&&contents&&!contents.isDestroyed()&&contents===this.contents()&&contents.getURL()===request.url&&this.eligible(request.url)&&this.state.snapshot?.url===request.url&&this.state.snapshot?.sourceId===request.sourceId;
    if(!request||typeof request.id!=='string'||request.id.length>100||!request.id||!['draft','send','stop','upload','link'].includes(request.kind)
      ||typeof request.sourceId!=='string'||!snapshot?.sourceId||!valid())return {ok:false,error:'会话尚未就绪或已变化，未执行操作。'};
    if(['draft','send'].includes(request.kind)&&(typeof request.expected!=='string'||request.expected.length>100000))return {ok:false,error:'草稿校验无效。'};
    if(request.kind==='draft'&&(typeof request.text!=='string'||request.text.length>100000))return {ok:false,error:'输入过长，单条草稿最多 100000 个字符。'};
    const signature=JSON.stringify(request),previous=this.actions.get(request.id);
    if(previous)return previous.signature===signature?previous.promise:{ok:false,error:'重复操作标识不匹配。'};
    if(this.actionPending)return {ok:false,error:'上一项网页操作尚未完成，请稍候。'};
    this.actionPending=true;
    const run=async()=>{
      try{
        let deadline;
        const result=await Promise.race([
          contents.executeJavaScript(`(${performConversationAction.toString()})(${JSON.stringify({...request,deadline:Date.now()+5000})})`,true).finally(()=>clearTimeout(deadline)),
          new Promise(resolve=>{deadline=setTimeout(()=>resolve({ok:false,error:'网页未及时确认操作，请核对；不会自动重试发送。'}),5500);deadline.unref?.();})
        ]);
        if(!valid())return {ok:false,error:'操作期间会话已变化，请核对原网页；不会自动重试。'};
        if(!result?.ok||request.kind!=='upload')return result;
        if(!this.chooseFiles)return {ok:false,error:'当前环境没有附件选择器。'};
        const selection=await this.chooseFiles(result.multiple);
        if(selection.canceled)return {ok:true,canceled:true};
        if(!valid())return {ok:false,error:'会话已变化，未添加附件。'};
        if(contents.debugger.isAttached())return {ok:false,error:'网页调试器正在使用，未添加附件；请关闭调试器后再试。'};
        let objectId;
        try{
          contents.debugger.attach('1.3');
          const target=await contents.debugger.sendCommand('Runtime.evaluate',{expression:`(()=>{const s=window.__thinkTankConversationReplica;return location.href===${JSON.stringify(request.url)}&&s?.id===${JSON.stringify(request.sourceId)}&&s.uploadTarget?.isConnected?s.uploadTarget:null})()`});
          objectId=target.result?.objectId;
          if(!objectId||!valid())return {ok:false,error:'附件入口已变化，未添加附件。'};
          await contents.debugger.sendCommand('DOM.setFileInputFiles',{objectId,files:selection.filePaths});
          return {ok:true};
        }finally{
          if(objectId&&contents.debugger.isAttached())await contents.debugger.sendCommand('Runtime.releaseObject',{objectId}).catch(()=>{});
          if(contents.debugger.isAttached())contents.debugger.detach();
        }
      }catch{return {ok:false,error:'网页操作未能确认，请核对当前会话；不会自动重试发送。'};}
      finally{this.actionPending=false;this.revision=-1;this.schedule(0);}
    };
    const promise=run();this.actions.set(request.id,{signature,promise});
    if(this.actions.size>100)this.actions.delete(this.actions.keys().next().value);
    return promise;
  }

  cleanup() {
    const contents = this.contents();
    if (!contents || contents.isDestroyed()) return;
    const url = contents.getURL();
    void contents.executeJavaScript(`(${readConversationDocument.toString()})(${JSON.stringify({url,dispose:true})})`).catch(()=>{});
  }

  summary() {
    const {snapshot,...summary} = this.state;
    return {...summary};
  }

  dispose() {
    this.disposed = true;
    this.epoch++;
    clearTimeout(this.timer);
    clearTimeout(this.deadline);
    this.state = {...this.state,active:false,snapshot:null};
  }
}

module.exports = { ChatReplica };
