const { spawn } = require('child_process');
const fs    = require('fs');
const path  = require('path');
const https = require('https');

/* ── Resolve yt-dlp binary: prefer venv (fast), fallback to standalone ── */

const ROOT   = path.join(__dirname, '..');
const MARKER = path.join(ROOT, 'bin', '.ytdlp-method');

function resolveYtdlp() {
  // 1. Check marker file from setup script
  try {
    const method = fs.readFileSync(MARKER, 'utf8').trim();
    if (method === 'venv') {
      const venvBin = path.join(ROOT, '.venv', 'bin', 'yt-dlp');
      if (fs.existsSync(venvBin)) return venvBin;
    }
  } catch {}

  // 2. Check if venv exists even without marker
  const venvBin = path.join(ROOT, '.venv', 'bin', 'yt-dlp');
  if (fs.existsSync(venvBin)) return venvBin;

  // 3. Check system-wide yt-dlp (pip installed globally)
  try {
    const { execSync } = require('child_process');
    const sysPath = execSync('which yt-dlp 2>/dev/null', { encoding: 'utf8' }).trim();
    if (sysPath && fs.existsSync(sysPath)) return sysPath;
  } catch {}

  // 4. Fallback: standalone binary
  return path.join(ROOT, 'bin', 'yt-dlp');
}

/* Lazy — resolved on first use so main.js ensureFastYtdlp() has time to run */
let _binary = null;
function getBinary() {
  if (!_binary) {
    _binary = resolveYtdlp();
  }
  return _binary;
}

const PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)([KMGT]iB)(?:\s+at\s+([\d.]+)\s*([KMGT]iB)\/s)?/;

function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
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

const VALID_HEIGHTS = new Set([360, 480, 720, 1080, 1440, 2160]);

function buildFormat(quality) {
  if (!quality || quality === 'best') {
    return 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';
  }
  const h = parseInt(quality, 10);
  // Reject stale/invalid quality values (e.g. ytdl-core format IDs like '18', '313')
  if (!VALID_HEIGHTS.has(h)) {
    return 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';
  }
  return (
    `best[height<=${h}][ext=mp4]` +
    `/bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]` +
    `/best[height<=${h}]/best`
  );
}

function fmtSpeed(bytesPerSec) {
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MiB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KiB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

class DownloadManager {
  constructor(outputPath, mainWindow, storage) {
    this.outputPath = outputPath;
    this.mainWindow = mainWindow;
    this.storage    = storage;

    // Active download tracking (for cancel)
    this._activeProc = null;
    this._cancelled  = false;
  }

  _log(line) {
    try { this.mainWindow.webContents.send('ytdlp-log', line); } catch {}
  }

  _sendStatus(status) {
    try { this.mainWindow.webContents.send('download-status', status); } catch {}
  }

  _sendProgress(data) {
    try { this.mainWindow.webContents.send('download-progress', data); } catch {}
  }

  /* ── FAST VIDEO INFO (oEmbed + page scrape) ────────────── */

  async getVideoInfo(url) {
    const videoId = extractVideoId(url);
    if (!videoId) throw new Error('Could not extract video ID from URL');

    this._sendStatus('Fetching video information…');
    this._log(`[info] fetching via oEmbed + page scrape (video=${videoId})`);

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

    let duration = 0;
    const durMatch = pageRes.data.match(/"approxDurationMs":"(\d+)"/);
    if (durMatch) duration = Math.round(parseInt(durMatch[1], 10) / 1000);

    this._sendStatus('');
    this._log(`[info] title="${title}" author="${author}" duration=${duration}s`);
    this._log(`[info] yt-dlp binary: ${getBinary()}`);

    return { id: videoId, title, author, duration, thumbnail };
  }

  /* ── YT-DLP DOWNLOAD ───────────────────────────────────── */

  _ytdlpDownload(url, filepath, format, info, filename) {
    this._sendStatus('Starting download…');
    this._log(`[yt-dlp] spawning: ${getBinary()}`);
    this._log(`[yt-dlp] format: ${format}`);

    return new Promise((resolve, reject) => {
      const proc = spawn(getBinary(), [
        url,
        '--output', filepath,
        '--format', format,
        '--no-warnings',
        '--no-playlist',
        '--no-check-certificate',
        '--newline',
        '--progress',
        '--no-color',
        '--socket-timeout', '10',
        '--extractor-args', 'youtube:player_client=android',
      ], { env: { ...process.env } });

      this._activeProc = proc;

      let totalSize = 0;
      let stderr    = '';
      let started   = false;

      const handleChunk = (chunk) => {
        const text  = chunk.toString();
        const lines = text.split(/\r?\n|\r/);
        for (const line of lines) {
          if (!line.trim()) continue;
          this._log(line);
          if (!started && /\[download\]/.test(line)) {
            started = true;
            this._sendStatus('Downloading…');
          }
          const m = PROGRESS_RE.exec(line);
          if (!m) continue;
          const percent     = Math.round(parseFloat(m[1]));
          totalSize         = parseSize(m[2], m[3]);
          const currentSize = Math.round((percent / 100) * totalSize);
          const speedVal    = m[4] ? parseFloat(m[4]) : 0;
          const speedUnit   = m[5] ? m[5] : '';
          const speed       = speedVal && speedUnit ? `${speedVal} ${speedUnit}/s` : '';
          this._sendProgress({ percent, totalSize, currentSize, speed });
        }
      };

      proc.stdout.on('data', handleChunk);
      proc.stderr.on('data', (chunk) => {
        handleChunk(chunk);
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        this._activeProc = null;

        if (this._cancelled) {
          fs.unlink(filepath, () => {});
          return reject(new Error('Download cancelled'));
        }

        if (code !== 0) {
          fs.unlink(filepath, () => {});
          const lastLine = stderr.split('\n').filter(Boolean).pop() || '';
          return reject(new Error(lastLine || `Download failed (exit ${code})`));
        }

        this._sendStatus('Download complete!');

        let fileSize = totalSize;
        try { fileSize = fs.statSync(filepath).size; } catch {}

        this.storage.addVideo({
          filename,
          title:     info.title,
          duration:  info.duration,
          size:      fileSize,
          thumbnail: info.thumbnail,
          url,
          dateAdded: new Date().toISOString(),
        });

        resolve({ success: true, filename, filepath, size: fileSize, url });
      });

      proc.on('error', (err) => {
        this._activeProc = null;
        fs.unlink(filepath, () => {});
        reject(new Error(`Failed to start yt-dlp: ${err.message}`));
      });
    });
  }

  /* ── DOWNLOAD ──────────────────────────────────────────── */

  async download(url, options) {
    this._cancelled = false;
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
    return this._ytdlpDownload(url, filepath, format, info, filename);
  }

  /* ── CANCEL ────────────────────────────────────────────── */

  cancel() {
    this._cancelled = true;
    if (this._activeProc) {
      this._log('[cancel] killing yt-dlp process');
      this._activeProc.kill('SIGTERM');
      this._activeProc = null;
    }
  }
}

module.exports = DownloadManager;
