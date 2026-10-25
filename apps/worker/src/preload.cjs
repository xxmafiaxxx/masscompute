// Preload: tiny typed bridge for the settings window.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('worker', {
  describe: () => ipcRenderer.invoke('worker:describe'),
  updateSettings: (patch) => ipcRenderer.invoke('worker:updateSettings', patch),
  onStatus: (cb) => ipcRenderer.on('status', (_e, line) => cb(line)),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
});
