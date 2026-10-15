import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantRuntimeProvider, useExternalStoreRuntime, ThreadPrimitive, MessagePrimitive, ActionBarPrimitive, AuiIf, type ThreadMessageLike } from '@assistant-ui/react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import DOMPurify from 'dompurify';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import './chat-replica.css';

type Message = {id:string;role:'user'|'assistant';html:string};
type Composer = {draft:string;version:number;canSend:boolean;canUpload:boolean;running:boolean;sending:boolean;files:string[]};
type Snapshot = {url:string;sourceId:string;revision:number;messages:Message[];running:boolean;truncated:boolean;composer?:Composer};
type ReplicaState = {enabled:boolean;active:boolean;status:string;message:string;token:string;snapshot:Snapshot|null};
type ReplicaApi = {
  onIndependentChat:(listener:(state:ReplicaState)=>void)=>()=>void;
  acknowledgeIndependentChat:(token:string)=>Promise<unknown>;
  setIndependentChat:(enabled:boolean)=>Promise<unknown>;
  independentChatAction:(request:Record<string,unknown>)=>Promise<unknown>;
  onDownload?:(listener:(state:{status:string;path?:string;error?:string})=>void)=>()=>void;
  openLastDownload:()=>Promise<unknown>;
};
const api = (window as unknown as {browserAssistant:ReplicaApi}).browserAssistant;
const initial:ReplicaState = {enabled:false,active:false,status:'off',message:'',token:'',snapshot:null};
// In-memory recovery only. Never apply an unacknowledged draft to another page.
const unsyncedDrafts=new Map<string,string>();
const NativeActions=createContext<(kind:string,actionId?:string)=>Promise<void>>(async()=>{});
type ActionResult={ok:boolean;error?:string;composer?:Composer;canceled?:boolean};
async function nativeAction(snapshot:Snapshot,kind:string,values:Record<string,unknown>={}):Promise<ActionResult>{
  const raw=await api.independentChatAction({id:crypto.randomUUID(),url:snapshot.url,sourceId:snapshot.sourceId,kind,...values}) as {ok:boolean;data?:ActionResult;error?:string};
  return raw.data || raw;
}
const turndown = new TurndownService({headingStyle:'atx',codeBlockStyle:'fenced'});
turndown.use(gfm);
turndown.remove(['button','input','textarea','form','script','style']);
turndown.addRule('images',{filter:'img',replacement:(_text,node)=>`[图片：${(node as Element).getAttribute('alt') || '请在原网页查看'}]`});

function markdown(html:string) {
  const fragment=DOMPurify.sanitize(html,{RETURN_DOM_FRAGMENT:true,FORBID_TAGS:['script','style','iframe','object','embed','form','input','textarea','button','svg'],FORBID_ATTR:['style','src','srcset','poster']});
  fragment.querySelectorAll('[hidden],[aria-hidden="true"]').forEach(node=>node.remove());
  fragment.querySelectorAll('details:not([open])').forEach(node=>{
    const summary=document.createElement('p');summary.textContent=(node.querySelector('summary')?.textContent || '工具详情')+'（详情请在原网页展开）';node.replaceWith(summary);
  });
  fragment.querySelectorAll('.katex').forEach(node=>{
    const tex=node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if(tex)node.replaceWith(document.createTextNode(node.closest('.katex-display')?`\n$$${tex}$$\n`:`$${tex}$`));
  });
  const container=document.createElement('div');container.append(fragment);
  return turndown.turndown(container);
}

function MarkdownText() {
  const action=useContext(NativeActions);
  return <MarkdownTextPrimitive className="replica-markdown" remarkPlugins={[remarkGfm,remarkMath]} rehypePlugins={[[rehypeKatex,{strict:false,trust:false}]]} smooth={false} components={{
    a:({children,href})=>{const id=href?.match(/^https:\/\/replica\.invalid\/action\/(\d+)$/)?.[1];return <button type="button" className="replica-link" disabled={!id} onClick={()=>void action('link',id)}>{children}</button>;},
    img:()=> <span>［图片请在原网页查看］</span>,
  }} />;
}

// Adapted from assistant-ui's MIT Claude example ChatMessage. Reuses the actual
// message, content, copy and thread primitives. The native composer remains the
// canonical draft; its mirror below deliberately has no second model runtime.
// Source and retained license: ./upstream/assistant-ui/UPSTREAM.json and LICENSE.
function ChatMessage() {
  return <MessagePrimitive.Root className="replica-message">
    <AuiIf condition={s=>s.message.role==='user'}><div className="replica-user"><MessagePrimitive.Parts components={{Text:MarkdownText}} /></div></AuiIf>
    <AuiIf condition={s=>s.message.role==='assistant'}><div className="replica-answer"><MessagePrimitive.Parts components={{Text:MarkdownText}} /></div></AuiIf>
    <ActionBarPrimitive.Root className="replica-actions"><ActionBarPrimitive.Copy aria-label="复制消息"><AuiIf condition={s=>s.message.isCopied}>已复制</AuiIf><AuiIf condition={s=>!s.message.isCopied}>复制</AuiIf></ActionBarPrimitive.Copy></ActionBarPrimitive.Root>
  </MessagePrimitive.Root>;
}

const convertMessage=(message:ThreadMessageLike)=>message;
class ReplicaBoundary extends React.Component<{children:React.ReactNode},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  componentDidCatch(){void api.setIndependentChat(false);}
  render(){return this.state.failed?null:this.props.children;}
}
function Conversation({state}:{state:ReplicaState}) {
  const snapshot=state.snapshot!;
  const recovery=useRef(unsyncedDrafts.get(snapshot.url));
  const confirmed=useRef<Composer>(snapshot.composer || {draft:'',version:0,canSend:false,canUpload:false,running:false,sending:false,files:[]});
  const [composer,setComposer]=useState(confirmed.current);
  const [draft,setDraft]=useState(recovery.current??confirmed.current.draft),text=useRef(draft),dirty=useRef(recovery.current!==undefined),composing=useRef(false);
  const [syncing,setSyncing]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(recovery.current!==undefined?'已恢复未同步的输入。请核对后同步，或采用网页草稿。':''),[download,setDownload]=useState('');
  const locked=useRef(false),failed=useRef(recovery.current!==undefined),flight=useRef<Promise<boolean>|null>(null),alive=useRef(true);
  const latest=useRef(snapshot);latest.current=snapshot;
  useEffect(()=>()=>{alive.current=false;},[]);
  function accept(value?:Composer){
    if(!value||value.version<confirmed.current.version)return;
    confirmed.current=value;setComposer(value);
    if(!dirty.current){text.current=value.draft;setDraft(value.draft);}
  }
  useEffect(()=>{accept(snapshot.composer);},[snapshot.composer]);
  useEffect(()=>api.onDownload?.(value=>setDownload(value.error|| (value.status==='completed'?`已保存：${value.path?.split(/[\\/]/).pop()}`:value.status==='progressing'?'正在下载…':''))),[]);
  function flush():Promise<boolean>{
    if(flight.current)return flight.current;
    if(composing.current||failed.current)return Promise.resolve(false);
    if(!dirty.current)return Promise.resolve(true);
    const run=async()=>{
      setSyncing(true);
      try{
        while(alive.current&&dirty.current){
          const intended=text.current;
          const result=await nativeAction(latest.current,'draft',{text:intended,expected:confirmed.current.draft});
          if(!alive.current)return false;
          accept(result.composer);
          if(!result.ok||result.composer?.draft!==intended){failed.current=true;setError(result.error||'网页尚未确认草稿，当前输入已保留。');return false;}
          if(text.current===intended){dirty.current=false;unsyncedDrafts.delete(latest.current.url);}
        }
        return true;
      }catch{failed.current=true;setError('草稿同步中断，当前输入已保留。请核对后重试。');return false;}
      finally{flight.current=null;if(alive.current)setSyncing(false);}
    };
    flight.current=run();return flight.current;
  }
  async function operate(kind:string,actionId?:string){
    if(locked.current)return;
    locked.current=true;setBusy(true);if(!failed.current)setError('');
    try{
      if(kind!=='stop'&&!await flush()&&kind!=='return')return;
      if(kind==='return'){await api.setIndependentChat(false);return;}
      const result=await nativeAction(latest.current,kind,{expected:confirmed.current.draft,...(actionId?{actionId}:{})});
      if(!alive.current)return;
      accept(result.composer);
      if(!result.ok)setError(result.error||'网页未确认操作，请核对后再试。');
    }catch{if(alive.current)setError('网页操作未确认，请核对；不会自动重试发送。');}
    finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  const cache=useRef(new Map<string,{html:string;message:ThreadMessageLike}>());
  const messages=useMemo(()=>{
    const next=new Map<string,{html:string;message:ThreadMessageLike}>();
    const result=(state.snapshot?.messages || []).map(item=>{
      const old=cache.current.get(item.id);
      const entry=old?.html===item.html ? old : {html:item.html,message:{id:item.id,role:item.role,content:[{type:'text' as const,text:markdown(item.html)}]}};
      next.set(item.id,entry);return entry.message;
    });
    cache.current=next;return result;
  },[state.snapshot]);
  const runtime=useExternalStoreRuntime({messages,convertMessage,isRunning:Boolean(state.snapshot?.running),isDisabled:true,onNew:async()=>{throw new Error('只读视图不发送消息');}});
  useEffect(()=>{ if(state.token&&state.snapshot)void api.acknowledgeIndependentChat(state.token); },[state.token,state.snapshot]);
  return <NativeActions.Provider value={operate}><AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root className="replica-thread">
      <header className="replica-header"><div><b>对话</b><span>独立渲染 · 实验</span></div><button disabled={busy||syncing} onClick={()=>void operate('return')}>返回原网页</button></header>
      <ThreadPrimitive.Viewport className="replica-viewport" aria-label="独立对话内容" turnAnchor="top" scrollToBottomOnRunStart={false} scrollToBottomOnInitialize={false} scrollToBottomOnThreadSwitch={false}>
        <div className="replica-transcript"><ThreadPrimitive.Messages components={{Message:ChatMessage}} />
          {!messages.length&&<p className="replica-empty">当前没有已加载的消息。在原网页开始对话后，这里会显示内容。</p>}
          {state.snapshot?.running&&<p className="replica-running" role="status">原网页正在生成，内容持续同步…</p>}
        </div>
        <div className="replica-scroll-wrap"><ThreadPrimitive.ScrollToBottom className="replica-scroll-bottom" aria-label="跳到最新消息">↓ 最新消息</ThreadPrimitive.ScrollToBottom></div>
      </ThreadPrimitive.Viewport>
      <footer className="replica-footer">
        <form className="replica-composer" onSubmit={event=>{event.preventDefault();if(!composing.current)void operate('send');}}>
          {!!composer.files.length&&<ul className="replica-files" aria-label="网页附件">{composer.files.map(file=><li key={file}>{file}</li>)}</ul>}
          <textarea aria-label="输入消息" placeholder="询问 ChatGPT" value={draft} disabled={busy} rows={2}
            onCompositionStart={()=>{composing.current=true;}}
            onCompositionEnd={()=>{composing.current=false;void flush();}}
            onChange={event=>{text.current=event.target.value;dirty.current=true;unsyncedDrafts.set(snapshot.url,text.current);setDraft(text.current);if(!composing.current)void flush();}}
            onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&!composing.current&&event.keyCode!==229){event.preventDefault();if(!busy&&!composer.running&&!composer.sending)void operate('send');}}}/>
          <div className="replica-compose-actions"><button type="button" disabled={busy||syncing||!composer.canUpload||composer.sending} onClick={()=>void operate('upload')}>＋ 添加附件</button>
            <span role="status">{syncing?'正在同步草稿…':composer.sending?'已请求发送，等待网页确认…':'与原网页同步'}</span>
            {composer.running?<button type="button" className="replica-submit" disabled={busy} onClick={()=>void operate('stop')}>停止生成</button>:<button type="submit" className="replica-submit" disabled={busy||syncing||!composer.canSend||composer.sending||failed.current}>发送 ↑</button>}
          </div>
        </form>
        {error&&<div className="replica-error" role="alert">{error}{failed.current&&<><button type="button" onClick={()=>{failed.current=false;setError('');void flush();}}>用当前输入重试同步</button><button type="button" onClick={()=>{dirty.current=false;failed.current=false;unsyncedDrafts.delete(snapshot.url);setError('');text.current=confirmed.current.draft;setDraft(text.current);}}>采用网页草稿</button></>}</div>}
        {download&&<p className="replica-download" role="status">{download} {download.startsWith('已保存')&&<button onClick={()=>void api.openLastDownload()}>打开文件</button>}</p>}
        {state.snapshot?.truncated&&<small>显示页面已加载的最近消息；完整内容以原网页为准。</small>}
      </footer>
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider></NativeActions.Provider>;
}

function IndependentChat() {
  const [state,setState]=useState<ReplicaState>(()=>(window as unknown as {__independentChatState?:ReplicaState}).__independentChatState || initial);
  useEffect(()=>{
    const listener=(event:Event)=>setState((event as CustomEvent<ReplicaState>).detail);
    document.addEventListener('independent-chat-state',listener);
    return ()=>document.removeEventListener('independent-chat-state',listener);
  },[]);
  return state.snapshot?<ReplicaBoundary key={state.snapshot.url+':'+state.snapshot.sourceId}><Conversation state={state}/></ReplicaBoundary>:null;
}
const root=document.getElementById('independentChatRoot');
if(root)createRoot(root).render(<IndependentChat/>);
