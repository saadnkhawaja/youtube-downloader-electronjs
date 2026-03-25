const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const path = require('path');

const QUALITY_MAP = {
  best:   null,
  '1080': 1080,
  '720':  720,
  '480':  480,
  '360':  360,
};

class DownloadManager {
  constructor(outputPath, mainWindow, storage) {
    this.outputPath = outputPath;
    this.mainWindow = mainWindow;
    this.storage = storage;
  }

  async getVideoInfo(url) {
    if (!ytdl.validateURL(url)) {
      throw new Error('Invalid YouTube URL');
    }

    const info = await ytdl.getInfo(url);
    const details = info.videoDetails;

    return {
      id: details.videoId,
      title: details.title,
      author: details.author.name,
      duration: parseInt(details.lengthSeconds, 10),
      thumbnail: details.thumbnails[details.thumbnails.length - 1].url,
    };
  }

  _pickFormat(formats, targetHeight) {
    const combined = formats.filter((f) => f.hasVideo && f.hasAudio);

    if (combined.length === 0) {
      throw new Error('No playable formats found for this video.');
    }

    const sorted = [...combined].sort((a, b) => (b.height || 0) - (a.height || 0));

    if (!targetHeight) return sorted[0];

    const exact = sorted.find((f) => f.height === targetHeight);
    if (exact) return exact;

    const below = sorted.find((f) => (f.height || 0) <= targetHeight);
    return below || sorted[sorted.length - 1];
  }

  async download(url, options) {
    if (!ytdl.validateURL(url)) {
      throw new Error('Invalid YouTube URL');
    }

    const info = await ytdl.getInfo(url);
    const details = info.videoDetails;
    const safeTitle = details.title.replace(/[/\\?%*:|"<>]/g, '-').trim();

    const ext = options.format === 'webm' ? 'webm' : 'mp4';
    let filename = `${safeTitle}.${ext}`;
    let filepath = path.join(this.outputPath, filename);

    let counter = 1;
    while (fs.existsSync(filepath)) {
      filename = `${safeTitle} (${counter}).${ext}`;
      filepath = path.join(this.outputPath, filename);
      counter++;
    }

    const targetHeight = QUALITY_MAP[options.quality] ?? null;
    const chosenFormat = this._pickFormat(info.formats, targetHeight);

    return new Promise((resolve, reject) => {
      const stream = ytdl.downloadFromInfo(info, { format: chosenFormat });
      const file = fs.createWriteStream(filepath);

      const totalSize = parseInt(chosenFormat.contentLength, 10) || 0;
      let downloaded = 0;

      stream.on('data', (chunk) => {
        downloaded += chunk.length;
        const percent = totalSize > 0 ? Math.round((downloaded / totalSize) * 100) : 0;
        this.mainWindow.webContents.send('download-progress', {
          percent,
          totalSize,
          currentSize: downloaded,
        });
      });

      stream.pipe(file);

      file.on('finish', () => {
        this.storage.addVideo({
          filename,
          title: details.title,
          duration: parseInt(details.lengthSeconds, 10),
          size: downloaded,
          thumbnail: details.thumbnails[details.thumbnails.length - 1].url,
          dateAdded: new Date().toISOString(),
        });

        resolve({ success: true, filename, filepath, size: downloaded });
      });

      stream.on('error', (err) => {
        file.destroy();
        fs.unlink(filepath, () => {});
        reject(new Error(`Download failed: ${err.message}`));
      });

      file.on('error', (err) => {
        stream.destroy();
        fs.unlink(filepath, () => {});
        reject(new Error(`Write failed: ${err.message}`));
      });
    });
  }
}

module.exports = DownloadManager;
