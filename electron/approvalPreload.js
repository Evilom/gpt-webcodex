const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('approvalAssistant', {
  onThemeChanged: (listener) => {
    const wrapped = (_event, mode) => listener(mode);
    ipcRenderer.on('theme:changed', wrapped);
    return () => ipcRenderer.removeListener('theme:changed', wrapped);
  },
  list: () => ipcRenderer.invoke('approval:list'),
  decide: (requestId, decision) => ipcRenderer.invoke('approval:decide', requestId, decision),
  close: () => ipcRenderer.invoke('approval-window:close'),
  onRefresh: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on('approval:refresh', wrapped);
    return () => ipcRenderer.removeListener('approval:refresh', wrapped);
  }
});
