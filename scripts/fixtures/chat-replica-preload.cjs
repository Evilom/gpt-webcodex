const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('independentChatPreview',{
  set:enabled=>ipcRenderer.invoke('test:replica-set',enabled),
  state:()=>ipcRenderer.invoke('test:replica-state'),
  action:request=>ipcRenderer.invoke('test:replica-action',request),
  ack:token=>ipcRenderer.invoke('test:replica-ack',token),
  insets:value=>ipcRenderer.invoke('test:replica-insets',value),
  onReplica:listener=>{ipcRenderer.on('chat:replica-state',(_event,state)=>listener(state));},
  onDownload:listener=>{const handler=(_event,state)=>listener(state);ipcRenderer.on('chat:download',handler);return ()=>ipcRenderer.removeListener('chat:download',handler);}
});
