const { contextBridge,ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nativePopoverPreview',{
  update:payload=>ipcRenderer.invoke('test:popover-update',payload),
  insets:payload=>ipcRenderer.invoke('test:popover-insets',payload),
  onEvent:listener=>{ipcRenderer.on('shell-popover:event',(_event,payload)=>listener(payload));}
});
