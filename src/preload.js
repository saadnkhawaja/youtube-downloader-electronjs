const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  windowMinimize:    ()           => ipcRenderer.send('window-minimize'),
  windowClose:       ()           => ipcRenderer.send('window-close'),
  openExternal:      (url)        => ipcRenderer.invoke('open-external', url),
  getVideos:         ()           => ipcRenderer.invoke('get-videos'),
  deleteVideo:       (filename)   => ipcRenderer.invoke('delete-video', filename),
  openFile:          (filename)   => ipcRenderer.invoke('open-file', filename),
  openFolder:        ()           => ipcRenderer.invoke('open-folder'),
  openOutputFolder:  ()           => ipcRenderer.invoke('open-output-folder'),
  getOutputPath:     ()           => ipcRenderer.invoke('get-output-path'),
  setOutputPath:     (p)          => ipcRenderer.invoke('set-output-path', p),
  getPreferences:    ()           => ipcRenderer.invoke('get-preferences'),
  setPreferences:    (prefs)      => ipcRenderer.invoke('set-preferences', prefs),
  downloadVideo:     (url, opts)  => ipcRenderer.invoke('download-video', url, opts),
  getVideoInfo:      (url)        => ipcRenderer.invoke('get-video-info', url),
  onDownloadProgress:(cb)         => ipcRenderer.on('download-progress', (_, data) => cb(data)),
  readClipboard:     ()           => {
    try { return navigator.clipboard.readText(); } catch { return Promise.resolve(''); }
  },
});
