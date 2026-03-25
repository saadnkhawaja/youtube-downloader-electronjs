const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVideos: () => ipcRenderer.invoke('get-videos'),
  deleteVideo: (filename) => ipcRenderer.invoke('delete-video', filename),
  openFile: (filename) => ipcRenderer.invoke('open-file', filename),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  openOutputFolder: () => ipcRenderer.invoke('open-output-folder'),
  getOutputPath: () => ipcRenderer.invoke('get-output-path'),
  setOutputPath: (path) => ipcRenderer.invoke('set-output-path', path),
  getPreferences: () => ipcRenderer.invoke('get-preferences'),
  setPreferences: (prefs) => ipcRenderer.invoke('set-preferences', prefs),
  downloadVideo: (url, options) => ipcRenderer.invoke('download-video', url, options),
  getVideoInfo: (url) => ipcRenderer.invoke('get-video-info', url),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, data) => callback(data)),
});
