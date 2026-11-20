const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopPdfBridge', {
  consumePendingPdf: () => ipcRenderer.invoke('pm:consume-pending-pdf'),
  saveFile: (name, uint8Array) => ipcRenderer.invoke('pm:save-file', name, uint8Array),
  onOpenExternalPdf: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => {
      callback(payload);
    };
    ipcRenderer.on('pm-open-external-pdf', handler);
    return () => {
      ipcRenderer.removeListener('pm-open-external-pdf', handler);
    };
  },
});
