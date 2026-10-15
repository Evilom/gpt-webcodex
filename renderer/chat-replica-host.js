(() => {
  const api=window.browserAssistant;
  let assets,received=false;
  function asset(tag,url) {
    return new Promise((resolve,reject)=>{
      const node=document.createElement(tag);
      if(tag==='link'){node.rel='stylesheet';node.href=url;}else node.src=url;
      node.onload=resolve;node.onerror=()=>reject(new Error('实验组件未能载入'));
      document.head.append(node);
    });
  }
  async function update(state) {
    if (!state || typeof state.enabled!=='boolean') return;
    window.__independentChatState=state;
    const root=document.getElementById('independentChatRoot');
    root.hidden=!state.enabled||!state.snapshot;
    if(state.enabled&&state.snapshot) {
      try {
        assets ||= asset('link','chat-dist/chat-replica.css').then(()=>asset('script','chat-dist/chat-replica.js'));
        await assets;
      } catch {
        assets=null;
        root.hidden=true;
        void api.setIndependentChat(false);
        return;
      }
    }
    document.dispatchEvent(new CustomEvent('independent-chat-state',{detail:window.__independentChatState}));
  }
  api.onIndependentChat?.(state=>{received=true;void update(state);});
  api.independentChatState?.().then(result=>{if(!received)void update(result?.ok?result.data:result);}).catch(()=>{});
})();
