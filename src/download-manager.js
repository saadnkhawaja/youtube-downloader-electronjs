const { spawn } = require('child_process');
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

/* ── Resolve yt-dlp: venv → system → standalone ── */
const ROOT   = path.join(__dirname, '..');
const MARKER = path.join(ROOT, 'bin', '.ytdlp-method');

function resolveYtdlp() {
  try {
    const m = fs.readFileSync(MARKER, 'utf8').trim();
    if (m === 'venv') {
      const b = path.join(ROOT, '.venv', 'bin', 'yt-dlp');
      if (fs.existsSync(b)) return b;
    }
  } catch {}
  const venv = path.join(ROOT, '.venv', 'bin', 'yt-dlp');
  if (fs.existsSync(venv)) return venv;
  try {
    const { execSync } = require('child_process');
    const sys = execSync('which yt-dlp 2>/dev/null', { encoding: 'utf8' }).trim();
    if (sys && fs.existsSync(sys)) return sys;
  } catch {}
  return path.join(ROOT, 'bin', 'yt-dlp');
}

let _binary = null;
const getBinary = () => { if (!_binary) _binary = resolveYtdlp(); return _binary; };

const PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)([KMGT]iB)(?:\s+at\s+([\d.]+)\s*([KMGT]iB)\/s)?(?:\s+ETA\s+(\S+))?/;

function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function httpGet(url) {
  const lib = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
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

function buildFormat(quality, format) {
  if (format === 'audio') return 'bestaudio/best';
  if (format === 'mkv') {
    if (!quality || quality === 'best') return 'bestvideo[ext=webm]+bestaudio[ext=webm]/bestvideo+bestaudio/best';
    const h = parseInt(quality, 10);
    if (!VALID_HEIGHTS.has(h)) return 'bestvideo+bestaudio/best';
    return `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
  }
  if (!quality || quality === 'best') return 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';
  const h = parseInt(quality, 10);
  if (!VALID_HEIGHTS.has(h)) return 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';
  return `best[height<=${h}][ext=mp4]/bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}]/best`;
}

class DownloadManager {
  constructor(outputPath, mainWindow, storage) {
    this.outputPath  = outputPath;
    this.mainWindow  = mainWindow;
    this.storage     = storage;
    this._activeProc = null;
    this._cancelled  = false;
    this._paused     = false;
  }

  _log(l)             { try { this.mainWindow.webContents.send('ytdlp-log', l); } catch {} }
  _sendStatus(s)      { try { this.mainWindow.webContents.send('download-status', s); } catch {} }
  _sendProgress(d)    { try { this.mainWindow.webContents.send('download-progress', d); } catch {} }

  async getVideoInfo(url) {
    const videoId = extractVideoId(url);
    if (!videoId) throw new Error('Could not extract video ID from URL');
    this._sendStatus('Fetching video information…');

    const [oembedRes, pageRes] = await Promise.all([
      httpGet(`https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${videoId}&format=json`),
      httpGet(`https://www.youtube.com/watch?v=${videoId}`),
    ]);

    let title = 'Unknown Title', author = 'Unknown';
    let thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    try {
      const o = JSON.parse(oembedRes.data);
      title = o.title || title; author = o.author_name || author; thumbnail = o.thumbnail_url || thumbnail;
    } catch {}

    let duration = 0;
    const dm = pageRes.data.match(/"approxDurationMs":"(\d+)"/);
    if (dm) duration = Math.round(parseInt(dm[1], 10) / 1000);

    this._sendStatus('');
    return { id: videoId, title, author, duration, thumbnail };
  }

  async download(url, options) {
    this._cancelled = false; this._paused = false;
    const info    = options.videoInfo || await this.getVideoInfo(url);
    const isAudio = options.format === 'audio';
    const safeTitle = info.title.replace(/[/\\?%*:|"<>]/g, '-').trim();

    let ext = 'mp4';
    if (isAudio)                        ext = 'm4a';
    else if (options.format === 'mkv')  ext = 'mkv';
    else if (options.format === 'webm') ext = 'webm';

    const outDir = this.storage.getOutputPath();
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    let filename = `${safeTitle}.${ext}`, filepath = path.join(outDir, filename), n = 1;
    while (fs.existsSync(filepath)) { filename = `${safeTitle} (${n}).${ext}`; filepath = path.join(outDir, filename); n++; }

    return this._ytdlpDownload(url, filepath, buildFormat(options.quality, options.format), info, filename, isAudio);
  }

  _ytdlpDownload(url, filepath, format, info, filename, isAudio) {
    this._sendStatus('Starting download…');
    this._log(`[yt-dlp] binary: ${getBinary()}`);
    this._log(`[yt-dlp] format: ${format}`);

    return new Promise((resolve, reject) => {
      const extractorArgs = isAudio
        ? 'youtube:player_client=web'       // web client exposes audio streams
        : 'youtube:player_client=android';  // android is faster for video

      const proc = spawn(getBinary(), [
        url, '--output', filepath, '--format', format,
        '--no-warnings', '--no-playlist', '--no-check-certificate',
        '--newline', '--progress', '--no-color', '--socket-timeout', '10',
        '--extractor-args', extractorArgs,
      ], { env: { ...process.env } });

      this._activeProc = proc;
      let totalSize = 0, stderr = '', started = false, actualFilepath = filepath;

      const handleChunk = (chunk) => {
        for (const line of chunk.toString().split(/\r?\n|\r/)) {
          if (!line.trim()) continue;
          this._log(line);
          const dest = line.match(/^\[download\] Destination: (.+)$/);
          if (dest) actualFilepath = dest[1].trim();
          if (!started && /\[download\]/.test(line)) { started = true; this._sendStatus('Downloading…'); }
          const m = PROGRESS_RE.exec(line);
          if (!m) continue;
          const percent = Math.round(parseFloat(m[1]));
          totalSize = parseSize(m[2], m[3]);
          this._sendProgress({
            percent, totalSize, currentSize: Math.round((percent / 100) * totalSize),
            speed: m[4] && m[5] ? `${m[4]} ${m[5]}/s` : '', eta: m[6] || '',
          });
        }
      };

      proc.stdout.on('data', handleChunk);
      proc.stderr.on('data', (c) => { handleChunk(c); stderr += c.toString(); });

      proc.on('close', (code) => {
        this._activeProc = null;
        if (this._cancelled) { try { fs.unlinkSync(actualFilepath); } catch {} return reject(new Error('Download cancelled')); }
        if (code !== 0) {
          try { fs.unlinkSync(actualFilepath); } catch {}
          return reject(new Error(stderr.split('\n').filter(Boolean).pop() || `Download failed (exit ${code})`));
        }
        this._sendStatus('Download complete!');
        const actualFilename = path.basename(actualFilepath);
        let fileSize = totalSize;
        try { fileSize = fs.statSync(actualFilepath).size; } catch {}
        this.storage.addVideo({
          filename: actualFilename, title: info.title, duration: info.duration,
          size: fileSize, thumbnail: info.thumbnail, url,
          type: isAudio ? 'audio' : 'video', dateAdded: new Date().toISOString(),
        });
        resolve({ success: true, filename: actualFilename, filepath: actualFilepath, size: fileSize, url, type: isAudio ? 'audio' : 'video' });
      });

      proc.on('error', (err) => {
        this._activeProc = null;
        try { fs.unlinkSync(actualFilepath); } catch {}
        reject(new Error(`Failed to start yt-dlp: ${err.message}`));
      });
    });
  }

  cancel()  {
    this._cancelled = true;
    if (this._activeProc) { this._activeProc.kill('SIGTERM'); this._activeProc = null; }
  }
  pause()   {
    if (this._activeProc && !this._paused) { this._activeProc.kill('SIGSTOP'); this._paused = true; this._sendStatus('Paused'); }
  }
  resume()  {
    if (this._activeProc && this._paused)  { this._activeProc.kill('SIGCONT'); this._paused = false; this._sendStatus('Downloading…'); }
  }
}

module.exports = DownloadManager;
