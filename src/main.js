const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { execSync } = require('child_process');
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const DownloadManager = require('./download-manager');
const Storage = require('./storage');

let mainWindow, downloadManager, storage;
const ROOT = path.join(__dirname, '..');

/* ── Auto-setup fast yt-dlp (pip venv) ── */
function ensureFastYtdlp() {
  const venvBin = path.join(ROOT, '.venv', 'bin', 'yt-dlp');
  if (fs.existsSync(venvBin)) return;
  const pythonCmd = ['python3', 'python'].find((cmd) => {
    try {
      const v = execSync(`${cmd} --version 2>&1`, { encoding: 'utf8' });
      const m = v.match(/(\d+)\.(\d+)/);
      return m && +m[1] >= 3 && +m[2] >= 8;
    } catch { return false; }
  });
  if (!pythonCmd) return;
  try {
    console.log('[snapy-yt] Setting up fast yt-dlp…');
    const venvDir = path.join(ROOT, '.venv');
    execSync(`${pythonCmd} -m venv "${venvDir}"`, { stdio: 'inherit' });
    execSync(`"${path.join(venvDir, 'bin', 'pip')}" install --quiet yt-dlp`, { stdio: 'inherit' });
  } catch (e) { console.warn('[snapy-yt] pip setup failed:', e.message); }
}

/* ── Window ── */
const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1280, height: 840, minWidth: 960, minHeight: 640,
    frame: false, transparent: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open DevTools with Cmd+Option+I (macOS) or F12
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.meta && input.alt && input.key === 'i') ||
        (input.control && input.shift && input.key === 'i') ||
        input.key === 'F12') {
      mainWindow.webContents.isDevToolsOpened()
        ? mainWindow.webContents.closeDevTools()
        : mainWindow.webContents.openDevTools();
    }
  });

  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools();
};

app.on('ready', () => {
  ensureFastYtdlp();
  const docsPath = path.join(os.homedir(), 'Documents', 'snapy-yt');
  if (!fs.existsSync(docsPath)) fs.mkdirSync(docsPath, { recursive: true });
  storage = new Storage(docsPath);
  createWindow();
  downloadManager = new DownloadManager(docsPath, mainWindow, storage);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });

/* ── IPC ── */
ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-close',    () => mainWindow.close());

ipcMain.handle('open-external',      async (_, url) => shell.openExternal(url));
ipcMain.handle('get-videos',         async ()       => storage.getVideos());
ipcMain.handle('delete-video',       async (_, f)   => storage.deleteVideo(f));
ipcMain.handle('trash-file', async (_, filename) => {
  const fp = path.join(storage.getOutputPath(), filename);
  try { await shell.trashItem(fp); storage.deleteVideo(filename); return true; }
  catch { return false; }
});
ipcMain.handle('open-file', async (_, filename) => {
  await shell.openPath(path.join(storage.getOutputPath(), filename));
});
ipcMain.handle('show-file-in-folder', async (_, filename) => {
  shell.showItemInFolder(path.join(storage.getOutputPath(), filename));
});
ipcMain.handle('open-output-folder', async () => shell.openPath(storage.getOutputPath()));
ipcMain.handle('open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'], defaultPath: storage.getOutputPath(),
  });
  if (!result.canceled && result.filePaths.length > 0) {
    storage.setOutputPath(result.filePaths[0]);
    return result.filePaths[0];
  }
  return null;
});
ipcMain.handle('get-output-path',  async ()        => storage.getOutputPath());
ipcMain.handle('set-output-path',  async (_, p)    => storage.setOutputPath(p));
ipcMain.handle('get-preferences',  async ()        => storage.getPreferences());
ipcMain.handle('set-preferences',  async (_, p)    => storage.setPreferences(p));
ipcMain.handle('download-video',   async (_, url, opts) => downloadManager.download(url, opts));
ipcMain.handle('cancel-download',  async ()        => downloadManager.cancel());
ipcMain.handle('pause-download',   async ()        => downloadManager.pause());
ipcMain.handle('resume-download',  async ()        => downloadManager.resume());
ipcMain.handle('get-video-info',   async (_, url)  => downloadManager.getVideoInfo(url));
