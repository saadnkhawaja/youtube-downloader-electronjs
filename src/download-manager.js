const { spawn } = require('child_process');
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

/* ── Resolve yt-dlp binary: prefer venv (fast), fallback to standalone ── */

const ROOT   = path.join(__dirname, '..');
const MARKER = path.join(ROOT, 'bin', '.ytdlp-method');

function resolveYtdlp() {
  try {
    const method = fs.readFileSync(MARKER, 'utf8').trim();
    if (method === 'venv') {
      const venvBin = path.join(ROOT, '.venv', 'bin', 'yt-dlp');
      if (fs.existsSync(venvBin)) return venvBin;
    }
  } catch {}
  // Fallback: standalone binary
  return path.join(ROOT, 'bin', 'yt-dlp');
}

const BINARY = resolveYtdlp();

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

function buildFormat(quality) {
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

function fmtSpeed(bytesPerSec) {
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MiB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KiB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

/* Extract a deeply nested JSON object that starts after `varName` in `text` */
function extractJSON(text, varName) {
  const idx = text.indexOf(varName);
  if (idx === -1) return null;
  const start = text.indexOf('{', idx);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < Math.min(start + 2_000_000, text.length); i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.substring(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

class DownloadManager {
  constructor(outputPath, mainWindow, storage) {
    this.outputPath = outputPath;
    this.mainWindow = mainWindow;
    this.storage    = storage;

    // Cached stream URLs from last getVideoInfo
    this._cachedStreams  = null;
    this._cachedVideoUrl = null;

    // Active download tracking (for cancel)
    this._activeProc = null;
    this._activeReq  = null;
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

  /* ── FAST VIDEO INFO (oEmbed + page scrape + stream extraction) ─── */

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

    // Extract streaming data from ytInitialPlayerResponse for direct downloads
    this._cachedStreams  = null;
    this._cachedVideoUrl = null;

    try {
      const playerData = extractJSON(pageRes.data, 'ytInitialPlayerResponse');
      if (playerData && playerData.streamingData) {
        const formats = [
          ...(playerData.streamingData.formats || []),
          ...(playerData.streamingData.adaptiveFormats || []),
        ].filter((f) => f.url && f.mimeType && f.mimeType.includes('video/mp4'));

        if (formats.length > 0) {
          this._cachedStreams  = formats;
          this._cachedVideoUrl = url;
          this._log(`[info] cached ${formats.length} direct stream URL(s) for instant download`);
          formats.forEach(f => this._log(`  → ${f.qualityLabel || f.quality || '?'} ${f.height || '?'}p bitrate=${f.bitrate || '?'} audio=${!!f.audioQuality}`));
        } else {
          this._log('[info] no direct stream URLs available (will use yt-dlp)');
        }
      }
    } catch (e) {
      this._log(`[warn] stream extraction failed: ${e.message}`);
    }

    this._sendStatus('');
    this._log(`[info] title="${title}" author="${author}" duration=${duration}s`);
    this._log(`[info] yt-dlp binary: ${BINARY}`);

    return { id: videoId, title, author, duration, thumbnail };
  }

  /* ── SELECT BEST MATCHING STREAM ───────────────────────── */

  _selectStream(formats, quality) {
    const preMerged = formats.filter(
      (f) => f.audioChannels || (f.mimeType && /audio/.test(f.mimeType))
            || (f.audioBitrate) || (f.audioQuality)
    );
    const pool = preMerged.length > 0 ? preMerged : formats;

    const sorted = [...pool].sort((a, b) => {
      const hDiff = (b.height || 0) - (a.height || 0);
      if (hDiff !== 0) return hDiff;
      return (b.bitrate || 0) - (a.bitrate || 0);
    });

    if (!quality || quality === 'best') return sorted[0] || null;

    const h = parseInt(quality, 10);
    return sorted.find((f) => (f.height || 0) <= h) || sorted[sorted.length - 1] || null;
  }

  /* ── DIRECT DOWNLOAD (Node.js HTTPS — instant start) ───── */

  _directDownload(stream, filepath, info, filename, videoUrl) {
    return new Promise((resolve, reject) => {
      this._sendStatus('Downloading…');
      this._log(`[download] direct HTTP download starting…`);

      const file      = fs.createWriteStream(filepath);
      const startTime = Date.now();
      let downloaded  = 0;
      let lastUpdate  = 0;
      const totalSize = parseInt(stream.contentLength, 10) || 0;

      const handleResponse = (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          try { fs.unlinkSync(filepath); } catch {}
          const redirectStream = { ...stream, url: res.headers.location };
          return this._directDownload(redirectStream, filepath, info, filename, videoUrl)
            .then(resolve).catch(reject);
        }

        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(filepath, () => {});
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        const total = parseInt(res.headers['content-length'], 10) || totalSize;
        this._log(`[download] connected, content-length=${total}`);

        res.on('data', (chunk) => {
          if (this._cancelled) { res.destroy(); return; }
          downloaded += chunk.length;
          const now = Date.now();
          if (now - lastUpdate > 300) {
            const percent    = total ? Math.round((downloaded / total) * 100) : 0;
            const elapsed    = (now - startTime) / 1000;
            const bytesPerSec = elapsed > 0 ? downloaded / elapsed : 0;
            const speed      = bytesPerSec > 0 ? fmtSpeed(bytesPerSec) : '';
            this._sendProgress({ percent, totalSize: total, currentSize: downloaded, speed });
            lastUpdate = now;
          }
        });

        res.pipe(file);

        file.on('finish', () => {
          file.close();
          if (this._cancelled) {
            fs.unlink(filepath, () => {});
            return reject(new Error('Download cancelled'));
          }

          const elapsed = (Date.now() - startTime) / 1000;
          this._sendProgress({
            percent: 100, totalSize: total, currentSize: total,
            speed: fmtSpeed(downloaded / (elapsed || 1)),
          });
          this._sendStatus('Download complete!');
          this._log(`[download] complete in ${elapsed.toFixed(1)}s`);

          let fileSize = total;
          try { fileSize = fs.statSync(filepath).size; } catch {}

          this.storage.addVideo({
            filename,
            title:     info.title,
            duration:  info.duration,
            size:      fileSize,
            thumbnail: info.thumbnail,
            url:       videoUrl,
            dateAdded: new Date().toISOString(),
          });

          this._activeReq = null;
          resolve({ success: true, filename, filepath, size: fileSize, url: videoUrl });
        });
      };

      const mod = stream.url.startsWith('https') ? https : http;
      const req = mod.get(stream.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      }, handleResponse);

      this._activeReq = req;

      req.on('error', (err) => {
        file.close();
        fs.unlink(filepath, () => {});
        this._activeReq = null;
        reject(err);
      });

      req.setTimeout(20000, () => {
        req.destroy();
        file.close();
        fs.unlink(filepath, () => {});
        this._activeReq = null;
        reject(new Error('Download request timed out'));
      });
    });
  }

  /* ── YT-DLP DOWNLOAD ───────────────────────────────────── */

  _ytdlpDownload(url, filepath, format, info, filename) {
    this._sendStatus('Starting download via yt-dlp…');
    this._log(`[yt-dlp] spawning: ${BINARY}`);
    this._log(`[yt-dlp] args: ${url} -f ${format}`);

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

  /* ── DOWNLOAD (direct first, yt-dlp fallback) ─────────── */

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

    // Try instant direct download from cached stream URLs
    if (this._cachedVideoUrl === url && this._cachedStreams && this._cachedStreams.length > 0) {
      const stream = this._selectStream(this._cachedStreams, options.quality);
      if (stream && stream.url) {
        this._log(`[download] using direct stream (height=${stream.height || '?'}, bitrate=${stream.bitrate || '?'})`);
        this._sendStatus('Starting download…');
        try {
          return await this._directDownload(stream, filepath, info, filename, url);
        } catch (err) {
          if (this._cancelled) throw err;
          this._log(`[download] direct download failed: ${err.message}, falling back to yt-dlp`);
          try { fs.unlinkSync(filepath); } catch {}
          this._sendStatus('Retrying with yt-dlp…');
        }
      }
    } else {
      this._log('[download] no cached streams, using yt-dlp directly');
    }

    // Fallback to yt-dlp
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
    if (this._activeReq) {
      this._log('[cancel] aborting HTTP request');
      this._activeReq.destroy();
      this._activeReq = null;
    }
  }
}

module.exports = DownloadManager;
