// A projection of the loaded page, with actions restricted to its current controls.
(function(root) {
  function readConversationDocument({ url, revision = -1, dispose = false }) {
    if (location.href !== url) return { supported:false,url:location.href };
    const key = '__thinkTankConversationReplica';
    if (dispose) {
      window[key]?.observer.disconnect();
      delete window[key];
      return true;
    }
    const main = document.querySelector('main');
    if (!main || !document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"]')) return { supported:false,url };
    let state = window[key];
    if (!state || state.main !== main) {
      state?.observer.disconnect();
      state = { main,url,lastSignature:null,pendingSignature:null,revision:0,observer:new MutationObserver(() => { state.revision++; }) };
      state.observer.observe(main,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','aria-hidden','aria-expanded','open','data-message-id']});
      window[key] = state;
      state.id = crypto.randomUUID();
      state.actions = new Map();
      state.actionIds = new WeakMap();
      state.nextAction = 0;
      state.requests = new Map();
      state.editor = () => document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"]');
      state.text = () => { const node=state.editor();return node?.tagName==='TEXTAREA'?node.value:node?.innerText || ''; };
      state.visible = node => Boolean(node&&!node.disabled&&node.getAttribute('aria-disabled')!=='true'&&!node.closest('[hidden],[aria-hidden="true"]')&&node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden');
      state.stop = () => [...document.querySelectorAll('button[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="停止生成"]')].find(state.visible);
      state.send = () => [...document.querySelectorAll('button[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="发送提示词"]')].find(state.visible);
      state.fileInput = () => {
        const inputs=[...document.querySelectorAll('input[type="file"]')].filter(node=>!node.disabled&&!node.hasAttribute('capture')&&!/audio|video/.test(node.accept));
        const local=inputs.filter(node=>state.editor()?.closest('form')?.contains(node));
        const broad=inputs.filter(node=>!node.accept||/application|\*/.test(node.accept));
        return local.length===1?local[0]:broad.length===1?broad[0]:inputs.length===1?inputs[0]:null;
      };
      state.composer = () => {
        const draft=state.text(),running=Boolean(state.stop());
        if(state.lastDraft!==draft){state.lastDraft=draft;state.draftVersion=(state.draftVersion||0)+1;}
        if(state.sendLock&&(running||state.sendLock.draft!==draft))state.sendLock=null;
        const form=state.editor()?.closest('form') || main;
        const files=[...form.querySelectorAll('input[type="file"]')].flatMap(node=>[...node.files].map(file=>file.name));
        const chips=[...form.querySelectorAll('[data-testid*="attachment"],[data-testid*="file-upload"],[data-testid="file-thumbnail"]')];
        for(const chip of chips){const label=chip.getAttribute('title')||chip.getAttribute('aria-label')||chip.textContent?.trim();if(label)files.push(label.slice(0,180));}
        return {draft,version:state.draftVersion,canSend:Boolean(state.send())&&!state.sendLock,running,sending:Boolean(state.sendLock),canUpload:Boolean(state.fileInput()),files:[...new Set(files)].slice(0,20)};
      };
    }
    const composer=state.composer(),running=composer.running,sourceId=state.id;
    if(state.url!==url){state.pendingSignature=state.lastSignature;state.url=url;}
    if (revision === state.revision && state.pendingSignature===null) return { supported:true,unchanged:true,url,sourceId,revision:state.revision,running,composer };
    const nodes = [...main.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]')].filter(node=>!node.closest('[hidden],[aria-hidden="true"]')&&node.getClientRects().length);
    let budget = 240000, truncated = nodes.length > 100;
    const ids = new Set();
    const messages = nodes.slice(-100).map((node,index) => {
      const turn = node.closest('[data-testid^="conversation-turn-"]');
      const id = node.getAttribute('data-message-id') || node.closest('[data-message-id]')?.getAttribute('data-message-id') || turn?.getAttribute('data-testid') || `visible-${index}`;
      const clone=node.cloneNode(true);
      const originals=[...node.querySelectorAll('a,button')],copies=[...clone.querySelectorAll('a,button')];
      originals.forEach((control,i)=>{
        const copy=copies[i],isLink=control.tagName==='A';
        if(!isLink&&!/download|下载/i.test([control.textContent,control.getAttribute('aria-label'),control.getAttribute('data-testid')].join(' ')))return;
        if(isLink&&!/^(https?:|blob:|sandbox:)/i.test(control.href))return;
        let actionId=state.actionIds.get(control);
        if(!actionId){actionId=String(++state.nextAction);state.actionIds.set(control,actionId);}
        state.actions.set(actionId,{node:control,signature:control.outerHTML});
        const anchor=document.createElement('a');anchor.href='https://replica.invalid/action/'+actionId;anchor.textContent=copy.textContent||control.getAttribute('aria-label')||'打开链接';copy.replaceWith(anchor);
      });
      const html = clone.innerHTML;
      const content = html.slice(0,Math.max(0,Math.min(24000,budget)));
      budget -= content.length;
      if (content.length !== html.length) truncated = true;
      const stableId = ids.has(id) ? `${id}:${index}` : id;
      ids.add(stableId);
      return { id:stableId,role:node.getAttribute('data-message-author-role'),html:content };
    });
    const signature=JSON.stringify(messages);
    if(state.pendingSignature!==null&&signature===state.pendingSignature)return {supported:false,settling:true,url};
    state.pendingSignature=null;state.lastSignature=signature;
    for(const [id,action] of state.actions)if(!action.node.isConnected)state.actions.delete(id);
    return { supported:true,url,sourceId,revision:state.revision,running,truncated,messages,composer };
  }
  function performConversationAction(request) {
    const state=window.__thinkTankConversationReplica;
    const fail=error=>({ok:false,error,composer:state?.composer?.()});
    if(!state||location.href!==request.url||state.url!==request.url||state.id!==request.sourceId||state.pendingSignature!==null||request.deadline&&Date.now()>request.deadline)return fail('会话已变化或操作已过期，请等待同步后再操作。');
    if(state.requests.has(request.id))return state.requests.get(request.id);
    const composer=state.composer();let result;
    if(request.kind==='draft'){
      if(composer.draft!==request.expected)return fail('原网页草稿已变化，已保留双方内容，请核对后再同步。');
      const editor=state.editor();
      if(editor.tagName==='TEXTAREA'){
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,request.text);
        editor.dispatchEvent(new Event('input',{bubbles:true}));
      }else{
        editor.focus();const range=document.createRange();range.selectNodeContents(editor);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
        if(!document.execCommand('insertText',false,request.text))return fail('网页输入控件暂不支持同步，草稿仍保留在实验界面。');
      }
      result={ok:true,composer:state.composer()};
    }else if(request.kind==='send'){
      if(composer.running||composer.sending||!composer.canSend)return fail('网页尚未准备好发送，请等待生成或附件处理结束。');
      if(composer.draft!==request.expected)return fail('网页草稿与当前输入不一致，未发送。');
      state.sendLock={draft:composer.draft};
      state.requests.set(request.id,{ok:true,pending:true});
      state.send().click();result={ok:true,composer:state.composer()};
    }else if(request.kind==='stop'){
      const stop=state.stop();if(!stop)return fail('当前网页没有可停止的生成。');
      state.requests.set(request.id,{ok:true});stop.click();result={ok:true,composer:state.composer()};
    }else if(request.kind==='upload'){
      state.uploadTarget=state.fileInput();if(!state.uploadTarget)return fail('网页没有提供可识别的附件入口，请在原网页确认。');
      result={ok:true,multiple:state.uploadTarget.multiple};
    }else if(request.kind==='link'){
      const action=state.actions.get(request.actionId);
      if(!action?.node.isConnected||action.signature!==action.node.outerHTML)return fail('链接已变化，请等待内容同步后再点击。');
      state.requests.set(request.id,{ok:true});action.node.click();result={ok:true};
    }else return fail('不支持的网页操作。');
    state.requests.set(request.id,result);if(state.requests.size>100)state.requests.delete(state.requests.keys().next().value);
    return result;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { readConversationDocument,performConversationAction };
  else {root.thinkTankReadConversation = readConversationDocument;root.thinkTankConversationAction=performConversationAction;}
})(globalThis);
