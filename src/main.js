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
    width: 1240,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    frame: false,
    transparent: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
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
  if (!fs.existsSync(docsPath)) fs.mkdirSync(docsPath, { recursive: true });

  storage = new Storage(docsPath);
  downloadManager = new DownloadManager(docsPath, mainWindow, storage);

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-close',    () => mainWindow.close());

ipcMain.handle('open-external', async (event, url) => {
  await shell.openExternal(url);
});

ipcMain.handle('get-videos', async () => storage.getVideos());

ipcMain.handle('delete-video', async (event, filename) => storage.deleteVideo(filename));

ipcMain.handle('open-file', async (event, filename) => {
  await shell.openPath(path.join(storage.getOutputPath(), filename));
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
  return null;
});

ipcMain.handle('get-output-path', async () => storage.getOutputPath());

ipcMain.handle('set-output-path', async (event, p) => storage.setOutputPath(p));

ipcMain.handle('get-preferences', async () => storage.getPreferences());

ipcMain.handle('set-preferences', async (event, prefs) => storage.setPreferences(prefs));

ipcMain.handle('download-video', async (event, url, options) => downloadManager.download(url, options));

ipcMain.handle('get-video-info', async (event, url) => downloadManager.getVideoInfo(url));
