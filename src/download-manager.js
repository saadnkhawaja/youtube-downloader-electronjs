const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const path = require('path');

class DownloadManager {
  constructor(outputPath, mainWindow, storage) {
    this.outputPath = outputPath;
    this.mainWindow = mainWindow;
    this.storage = storage;
  }

  async getVideoInfo(url) {
    try {
      if (!ytdl.validateURL(url)) {
        throw new Error('Invalid YouTube URL');
      }

      const info = await ytdl.getInfo(url);
      const videoDetails = info.videoDetails;

      return {
        id: videoDetails.videoId,
        title: videoDetails.title,
        author: videoDetails.author.name,
        duration: videoDetails.lengthSeconds,
        thumbnail: videoDetails.thumbnails[videoDetails.thumbnails.length - 1].url,
        description: videoDetails.shortDescription,
      };
    } catch (error) {
      throw new Error(`Failed to fetch video info: ${error.message}`);
    }
  }

  async download(url, options) {
    try {
      if (!ytdl.validateURL(url)) {
        throw new Error('Invalid YouTube URL');
      }

      const info = await ytdl.getInfo(url);
      const videoDetails = info.videoDetails;
      const videoTitle = videoDetails.title.replace(/[/\\?%*:|"<>]/g, '-');

      const format = options.format || 'mp4';
      const quality = options.quality || '18';

      let filename = `${videoTitle}.${format === 'mp4' ? 'mp4' : 'mkv'}`;
      let filepath = path.join(this.outputPath, filename);

      let counter = 1;
      while (fs.existsSync(filepath)) {
        const ext = path.extname(filename);
        const name = path.basename(filename, ext);
        filename = `${name} (${counter})${ext}`;
        filepath = path.join(this.outputPath, filename);
        counter++;
      }

      return new Promise((resolve, reject) => {
        const stream = ytdl(url, { quality });
        const writeStream = fs.createWriteStream(filepath);

        let totalSize = 0;
        let downloadedSize = 0;

        stream.on('info', (info, format) => {
          totalSize = format.contentLength || 0;
        });

        stream.on('data', (chunk) => {
          downloadedSize += chunk.length;
          const percent = totalSize ? Math.round((downloadedSize / totalSize) * 100) : 0;

          this.mainWindow.webContents.send('download-progress', {
            percent,
            totalSize,
            currentSize: downloadedSize,
          });
        });

        stream.pipe(writeStream);

        writeStream.on('finish', () => {
          this.storage.addVideo({
            filename,
            title: videoDetails.title,
            duration: videoDetails.lengthSeconds,
            size: downloadedSize,
            thumbnail: videoDetails.thumbnails[videoDetails.thumbnails.length - 1].url,
            dateAdded: new Date().toISOString(),
          });

          resolve({
            success: true,
            filename,
            filepath,
            size: downloadedSize,
          });
        });

        stream.on('error', (error) => {
          fs.unlink(filepath, () => {});
          reject(new Error(`Download failed: ${error.message}`));
        });

        writeStream.on('error', (error) => {
          fs.unlink(filepath, () => {});
          reject(new Error(`Write failed: ${error.message}`));
        });
      });
    } catch (error) {
      throw new Error(`Download error: ${error.message}`);
    }
  }
}

module.exports = DownloadManager;
