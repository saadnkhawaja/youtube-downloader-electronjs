const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const BINARY = path.join(__dirname, '..', 'bin', 'yt-dlp');

const PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)([KMGT]iB)/;

function parseSize(num, unit) {
  const n = parseFloat(num);
  const map = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
  return Math.round(n * (map[unit] || 1));
}

function buildFormat(quality) {
  if (!quality || quality === 'best') {
    return 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
  }
  const h = parseInt(quality, 10);
  return (
    `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]` +
    `/best[height<=${h}][ext=mp4]/best[height<=${h}]/best[ext=mp4]/best`
  );
}

function run(args, onData) {
  return new Promise((resolve, reject) => {
    const proc = spawn(BINARY, args, { env: { ...process.env } });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      stdout += s;
      if (onData) onData(s);
    });

    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderr += s;
      if (onData) onData(s);
    });

    proc.on('close', (code) => {
      if (code === 0) return resolve(stdout);
      reject(new Error(stderr.split('\n').filter(Boolean).pop() || `yt-dlp exited with code ${code}`));
    });

    proc.on('error', (err) => reject(new Error(`Failed to start yt-dlp: ${err.message}`)));
  });
}

class DownloadManager {
  constructor(outputPath, mainWindow, storage) {
    this.outputPath = outputPath;
    this.mainWindow = mainWindow;
    this.storage    = storage;
  }

  async getVideoInfo(url) {
    const json = await run([
      url,
      '--dump-single-json',
      '--no-warnings',
      '--no-call-home',
      '--no-check-certificate',
    ]);

    const info = JSON.parse(json);

    return {
      id:        info.id,
      title:     info.title,
      author:    info.uploader || info.channel || info.uploader_id || 'Unknown',
      duration:  info.duration,
      thumbnail: info.thumbnail,
    };
  }

  async download(url, options) {
    const info      = await this.getVideoInfo(url);
    const safeTitle = info.title.replace(/[/\\?%*:|"<>]/g, '-').trim();
    const ext       = options.format === 'webm' ? 'webm' : 'mp4';

    let filename = `${safeTitle}.${ext}`;
    let filepath = path.join(this.outputPath, filename);
    let counter  = 1;
    while (fs.existsSync(filepath)) {
      filename = `${safeTitle} (${counter}).${ext}`;
      filepath = path.join(this.outputPath, filename);
      counter++;
    }

    const format = buildFormat(options.quality);

    return new Promise((resolve, reject) => {
      const proc = spawn(BINARY, [
        url,
        '--output', filepath,
        '--format', format,
        '--no-warnings',
        '--no-call-home',
        '--no-check-certificate',
        '--newline',
      ], { env: { ...process.env } });

      let totalSize = 0;
      let stderr    = '';

      const handleChunk = (chunk) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          const m = PROGRESS_RE.exec(line);
          if (!m) continue;
          const percent = Math.round(parseFloat(m[1]));
          totalSize = parseSize(m[2], m[3]);
          this.mainWindow.webContents.send('download-progress', {
            percent,
            totalSize,
            currentSize: Math.round((percent / 100) * totalSize),
          });
        }
      };

      proc.stdout.on('data', handleChunk);
      proc.stderr.on('data', (chunk) => {
        handleChunk(chunk);
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          fs.unlink(filepath, () => {});
          const lastLine = stderr.split('\n').filter(Boolean).pop() || '';
          return reject(new Error(lastLine || `Download failed (exit ${code})`));
        }

        let fileSize = totalSize;
        try { fileSize = fs.statSync(filepath).size; } catch {}

        this.storage.addVideo({
          filename,
          title:     info.title,
          duration:  info.duration,
          size:      fileSize,
          thumbnail: info.thumbnail,
          dateAdded: new Date().toISOString(),
        });

        resolve({ success: true, filename, filepath, size: fileSize });
      });

      proc.on('error', (err) => {
        fs.unlink(filepath, () => {});
        reject(new Error(`Failed to start download: ${err.message}`));
      });
    });
  }
}

module.exports = DownloadManager;
