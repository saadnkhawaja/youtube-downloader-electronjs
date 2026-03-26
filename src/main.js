const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const DownloadManager = require('./download-manager');
const Storage = require('./storage');

let mainWindow;
let downloadManager;
let storage;

const ROOT = path.join(__dirname, '..');

/* ── Auto-setup fast yt-dlp (pip in venv) if Python is available ── */

function ensureFastYtdlp() {
  const venvBin = path.join(ROOT, '.venv', 'bin', 'yt-dlp');
  if (fs.existsSync(venvBin)) return; // already set up

  // Find Python 3.8+
  const pythonCmd = ['python3', 'python'].find((cmd) => {
    try {
      const ver = execSync(`${cmd} --version 2>&1`, { encoding: 'utf8' });
      const m = ver.match(/(\d+)\.(\d+)/);
      return m && parseInt(m[1], 10) >= 3 && parseInt(m[2], 10) >= 8;
    } catch { return false; }
  });

  if (!pythonCmd) {
    console.log('[snapy-yt] Python 3.8+ not found, using standalone yt-dlp binary.');
    return;
  }

  try {
    console.log('[snapy-yt] Setting up fast yt-dlp via pip…');
    const venvDir = path.join(ROOT, '.venv');
    execSync(`${pythonCmd} -m venv "${venvDir}"`, { stdio: 'inherit' });
    execSync(`"${path.join(venvDir, 'bin', 'pip')}" install --quiet yt-dlp`, { stdio: 'inherit' });
    console.log('[snapy-yt] yt-dlp installed via pip (fast mode).');
  } catch (e) {
    console.warn('[snapy-yt] Failed to setup pip yt-dlp:', e.message);
  }
}

/* ── Window ── */

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    frame: false,
    transparent: false,
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
  // Auto-setup fast yt-dlp before anything else
  ensureFastYtdlp();

  const docsPath = path.join(os.homedir(), 'Documents', 'snapy-yt');
  if (!fs.existsSync(docsPath)) fs.mkdirSync(docsPath, { recursive: true });

  storage = new Storage(docsPath);
  createWindow();
  downloadManager = new DownloadManager(docsPath, mainWindow, storage);
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

ipcMain.handle('cancel-download', async () => downloadManager.cancel());

ipcMain.handle('get-video-info', async (event, url) => downloadManager.getVideoInfo(url));
