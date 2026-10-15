const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('shellPopover', {
  onRender: listener => { ipcRenderer.on('shell-popover:render', (_event, payload) => listener(payload)); },
  send: payload => ipcRenderer.send('shell-popover:event', payload)
});
