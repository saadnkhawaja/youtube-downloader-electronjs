const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const DownloadManager = require('./download-manager');
const Storage = require('./storage');

let mainWindow;
let downloadManager;
let storage;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      enableRemoteModule: false,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
};

app.on('ready', () => {
  const docsPath = path.join(os.homedir(), 'Documents', 'snapy-yt');

  if (!fs.existsSync(docsPath)) {
    fs.mkdirSync(docsPath, { recursive: true });
  }

  storage = new Storage(docsPath);
  downloadManager = new DownloadManager(docsPath, mainWindow, storage);

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

ipcMain.handle('get-videos', async () => {
  return storage.getVideos();
});

ipcMain.handle('delete-video', async (event, filename) => {
  return storage.deleteVideo(filename);
});

ipcMain.handle('open-file', async (event, filename) => {
  const filepath = path.join(storage.getOutputPath(), filename);
  await shell.openPath(filepath);
});

ipcMain.handle('open-output-folder', async () => {
  await shell.openPath(storage.getOutputPath());
});

ipcMain.handle('open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: storage.getOutputPath(),
  });

  if (!result.canceled && result.filePaths.length > 0) {
    storage.setOutputPath(result.filePaths[0]);
    return result.filePaths[0];
  }
});

ipcMain.handle('get-output-path', async () => {
  return storage.getOutputPath();
});

ipcMain.handle('set-output-path', async (event, path) => {
  storage.setOutputPath(path);
});

ipcMain.handle('get-preferences', async () => {
  return storage.getPreferences();
});

ipcMain.handle('set-preferences', async (event, prefs) => {
  storage.setPreferences(prefs);
});

ipcMain.handle('download-video', async (event, url, options) => {
  return downloadManager.download(url, options);
});

ipcMain.handle('get-video-info', async (event, url) => {
  return downloadManager.getVideoInfo(url);
});
