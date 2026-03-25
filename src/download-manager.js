const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');

function buildFormat(quality) {
  if (!quality || quality === 'best') {
    return 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
  }
  const h = parseInt(quality, 10);
  return (
    `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]` +
    `/best[height<=${h}][ext=mp4]` +
    `/best[height<=${h}]` +
    `/best[ext=mp4]/best`
  );
}

const PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)([KMGT]iB)/;

function parseSize(num, unit) {
  const n = parseFloat(num);
  switch (unit) {
    case 'KiB': return Math.round(n * 1024);
    case 'MiB': return Math.round(n * 1024 * 1024);
    case 'GiB': return Math.round(n * 1024 * 1024 * 1024);
    case 'TiB': return Math.round(n * 1024 * 1024 * 1024 * 1024);
    default:    return Math.round(n);
  }
}

class DownloadManager {
  constructor(outputPath, mainWindow, storage) {
    this.outputPath = outputPath;
    this.mainWindow = mainWindow;
    this.storage    = storage;
  }

  async getVideoInfo(url) {
    const info = await youtubedl(url, {
      dumpSingleJson:     true,
      noWarnings:         true,
      noCallHome:         true,
      noCheckCertificate: true,
      preferFreeFormats:  true,
    });

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
      const subprocess = youtubedl.exec(url, {
        output:             filepath,
        format,
        noWarnings:         true,
        noCallHome:         true,
        noCheckCertificate: true,
      });

      let lastPercent = 0;
      let totalSize   = 0;

      const handleLine = (line) => {
        const m = PROGRESS_RE.exec(line);
        if (!m) return;
        lastPercent = Math.round(parseFloat(m[1]));
        totalSize   = parseSize(m[2], m[3]);
        this.mainWindow.webContents.send('download-progress', {
          percent:     lastPercent,
          totalSize,
          currentSize: Math.round((lastPercent / 100) * totalSize),
        });
      };

      subprocess.stdout?.on('data', (d) => String(d).split('\n').forEach(handleLine));
      subprocess.stderr?.on('data', (d) => String(d).split('\n').forEach(handleLine));

      subprocess.on('close', (code) => {
        if (code !== 0) {
          fs.unlink(filepath, () => {});
          return reject(new Error('yt-dlp exited with code ' + code));
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

      subprocess.on('error', (err) => {
        fs.unlink(filepath, () => {});
        reject(new Error('Spawn error: ' + err.message));
      });
    });
  }
}

module.exports = DownloadManager;
