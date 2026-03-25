const { spawn } = require('child_process');
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const BINARY = path.join(__dirname, '..', 'bin', 'yt-dlp');

const PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)([KMGT]iB)(?:\s+at\s+([\d.]+)([KMGT]iB)\/s)?/;

function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; snapy-yt/1.0)' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function parseSize(num, unit) {
  const n = parseFloat(num);
  const map = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
  return Math.round(n * (map[unit] || 1));
}

function buildFormat(quality) {
  // Prefer pre-merged mp4 (no ffmpeg needed), then fall back to merge, then anything
  if (!quality || quality === 'best') {
    return 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';
  }
  const h = parseInt(quality, 10);
  return (
    `best[height<=${h}][ext=mp4]` +
    `/bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]` +
    `/best[height<=${h}]/best`
  );
}

function run(args, onLog) {
  return new Promise((resolve, reject) => {
    const log = (line) => { if (onLog) onLog(line); };

    log(`[spawn] ${BINARY}`);
    log(`[args]  ${args.join(' ')}\n`);

    let proc;
    try {
      proc = spawn(BINARY, args, { env: { ...process.env } });
    } catch (err) {
      log(`[error] spawn failed: ${err.message}`);
      return reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    }

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      stdout += s;
      s.split('\n').filter(Boolean).forEach((l) => log(`[stdout] ${l}`));
    });

    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderr += s;
      s.split('\n').filter(Boolean).forEach((l) => log(`[stderr] ${l}`));
    });

    proc.on('close', (code) => {
      log(`[exit] code=${code}`);
      if (code === 0) return resolve(stdout);
      reject(new Error(stderr.split('\n').filter(Boolean).pop() || `yt-dlp exited with code ${code}`));
    });

    proc.on('error', (err) => {
      log(`[error] ${err.message}`);
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });
  });
}

class DownloadManager {
  constructor(outputPath, mainWindow, storage) {
    this.outputPath = outputPath;
    this.mainWindow = mainWindow;
    this.storage    = storage;
  }

  _log(line) {
    this.mainWindow.webContents.send('ytdlp-log', line);
  }

  async getVideoInfo(url) {
    const videoId = extractVideoId(url);
    if (!videoId) throw new Error('Could not extract video ID from URL');

    this._log(`[info] fetching via oEmbed API (video=${videoId})`);

    const oembedUrl = `https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${videoId}&format=json`;
    const pageUrl   = `https://www.youtube.com/watch?v=${videoId}`;

    const [oembedRes, pageRes] = await Promise.all([
      httpGet(oembedUrl),
      httpGet(pageUrl),
    ]);

    let title     = 'Unknown Title';
    let author    = 'Unknown';
    let thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    try {
      const oembed = JSON.parse(oembedRes.data);
      title     = oembed.title       || title;
      author    = oembed.author_name || author;
      thumbnail = oembed.thumbnail_url || thumbnail;
    } catch (e) {
      this._log(`[warn] oEmbed parse failed: ${e.message}`);
    }

    // Pull duration from the embedded ytInitialPlayerResponse on the page
    let duration = 0;
    const durMatch = pageRes.data.match(/"approxDurationMs":"(\d+)"/);
    if (durMatch) duration = Math.round(parseInt(durMatch[1], 10) / 1000);

    this._log(`[info] title="${title}" author="${author}" duration=${duration}s`);

    return { id: videoId, title, author, duration, thumbnail };
  }

  async download(url, options) {
    // Use pre-fetched info from the Fetch step to avoid a second 20-25s lookup
    const info = options.videoInfo || await this.getVideoInfo(url);
    const safeTitle = info.title.replace(/[/\\?%*:|"<>]/g, '-').trim();
    const ext       = options.format === 'webm' ? 'webm' : 'mp4';
    const outDir    = this.storage.getOutputPath();

    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    let filename = `${safeTitle}.${ext}`;
    let filepath = path.join(outDir, filename);
    let counter  = 1;
    while (fs.existsSync(filepath)) {
      filename = `${safeTitle} (${counter}).${ext}`;
      filepath = path.join(outDir, filename);
      counter++;
    }

    const format = buildFormat(options.quality);

    return new Promise((resolve, reject) => {
      const proc = spawn(BINARY, [
        url,
        '--output', filepath,
        '--format', format,
        '--no-warnings',
        '--no-playlist',
        '--no-check-certificate',
        '--newline',
        '--progress',
        '--no-color',
      ], { env: { ...process.env } });

      let totalSize = 0;
      let stderr    = '';

      const handleChunk = (chunk) => {
        // yt-dlp uses \r for in-place updates; --newline switches to \n but split both
        const lines = chunk.toString().split(/\r?\n|\r/);
        for (const line of lines) {
          const m = PROGRESS_RE.exec(line);
          if (!m) continue;
          const percent     = Math.round(parseFloat(m[1]));
          totalSize         = parseSize(m[2], m[3]);
          const currentSize = Math.round((percent / 100) * totalSize);
          const speedVal    = m[4] ? parseFloat(m[4]) : 0;
          const speedUnit   = m[5] ? m[5] : '';
          const speed       = speedVal && speedUnit
            ? `${speedVal} ${speedUnit}/s`
            : '';
          this.mainWindow.webContents.send('download-progress', {
            percent,
            totalSize,
            currentSize,
            speed,
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
