/* ── snapy-yt renderer ── */
const GITHUB_URL = 'https://github.com/saadnkhawaja';
const YT_REGEX   = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?.*v=|shorts\/)|youtu\.be\/).+/i;
const ITEMS_PER_PAGE = 10;

class SnapyYT {
  constructor() {
    this.currentUrl      = '';
    this.currentInfo     = null;
    this.selectedQuality = 'best';
    this.selectedFormat  = 'mp4';

    // Auto Start settings
    this.autoStart        = false;
    this.autoStartQuality = 'best';
    this.autoStartFormat  = 'mp4';

    // Clipboard monitoring
    this._lastClipboard   = '';
    this._clipboardTimer  = null;

    // Queue
    this.downloadQueue   = [];   // { id, url, info, quality, format, title, thumb }
    this.isDownloading   = false;
    this._dlIdCounter    = 0;
    this._isPaused       = false;

    // Session downloads (active + recent)
    this.sessionDownloads = []; // { id, title, thumb, url, percent, status, size, filename, type, speed, eta }

    // Gallery state
    this._galleryAll     = [];
    this._galleryFilter  = 'all';
    this._gallerySearch  = '';
    this._gallerySort    = 'date-desc';
    this._galleryPage    = 1;

    this.bindTitlebar();
    this.bindNav();
    this.initTheme();
    this.bindFab();
    this.bindDownloader();
    this.bindGallery();
    this.bindSettings();

    window.electronAPI.onDownloadProgress((d) => this.handleProgress(d));
    window.electronAPI.onDownloadStatus((s)   => this.handleStatus(s));

    this.outputDir = '';
    this.loadOutputPath();
    this.loadSettings();
    this.loadRecentDownloads();
    this.loadGallery();
    this.startClipboardMonitor();
  }

  /* ═══ TITLEBAR ═══════════════════════════════ */
  bindTitlebar() {
    document.getElementById('btnMinimize').onclick = () => window.electronAPI.windowMinimize();
    document.getElementById('btnClose').onclick    = () => window.electronAPI.windowClose();
  }

  /* ═══ NAVIGATION ═════════════════════════════ */
  bindNav() {
    document.querySelectorAll('.nav-item').forEach(btn =>
      btn.addEventListener('click', () => this.navigate(btn.dataset.page))
    );
  }
  navigate(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.getElementById(page).classList.add('active');
    document.querySelector(`[data-page="${page}"]`).classList.add('active');
    if (page === 'gallery') this.loadGallery();
  }

  /* ═══ THEME ═══════════════════════════════════ */
  initTheme() {
    const saved = localStorage.getItem('theme') || 'dark';
    this.applyTheme(saved);
    document.getElementById('themeToggle').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'dark';
      this.applyTheme(cur === 'dark' ? 'light' : 'dark');
    });
  }
  applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    document.getElementById('themeLabel').textContent = t === 'dark' ? 'Light Mode' : 'Dark Mode';
    localStorage.setItem('theme', t);
  }

  /* ═══ FAB ═════════════════════════════════════ */
  bindFab() {
    document.getElementById('fabBtn').addEventListener('click', async () => {
      this.navigate('downloader');
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (YT_REGEX.test(text)) {
          document.getElementById('urlInput').value = text;
          this.toast('YouTube URL pasted!', 'success');
        }
      } catch { document.getElementById('urlInput').focus(); }
    });
    document.getElementById('githubLink').addEventListener('click', () => window.electronAPI.openExternal(GITHUB_URL));
  }

  /* ═══ DOWNLOADER ══════════════════════════════ */
  bindDownloader() {
    document.getElementById('fetchBtn').addEventListener('click', () => this.fetchInfo());
    document.getElementById('urlInput').addEventListener('keydown', e => { if (e.key === 'Enter') this.fetchInfo(); });
    document.getElementById('downloadBtn').addEventListener('click', () => this.startDownload());
    document.getElementById('addToQueueBtn').addEventListener('click', () => this.addCurrentToQueue());
    document.getElementById('clearCompletedBtn').addEventListener('click', () => this.clearCompleted());
    document.getElementById('clearQueueBtn').addEventListener('click', () => this.clearQueue());
    document.getElementById('folderChipBtn').addEventListener('click', async () => {
      const p = await window.electronAPI.openFolder();
      if (p) { this.outputDir = p; this.setOutputPathLabel(p); }
    });

    // Quality pills
    document.querySelectorAll('#qualityPills .pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#qualityPills .pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedQuality = btn.dataset.quality;
      });
    });

    // Format pills — hide quality when audio selected
    document.querySelectorAll('#formatPills .pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#formatPills .pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedFormat = btn.dataset.format;
        document.getElementById('qualityPills').closest('.opt-row').style.display =
          this.selectedFormat === 'audio' ? 'none' : '';
      });
    });
  }

  _pauseIcon()  { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`; }
  _resumeIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3"/></svg>`; }

  async loadOutputPath() {
    try { const p = await window.electronAPI.getOutputPath(); this.outputDir = p; this.setOutputPathLabel(p); } catch {}
  }
  setOutputPathLabel(p) {
    const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
    document.getElementById('outputPathLabel').textContent = parts.length >= 2 ? parts.slice(-2).join('/') : p;
  }

  /* ─── Clipboard monitor ─── */
  startClipboardMonitor() {
    const checkClipboard = async () => {
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (text && text !== this._lastClipboard && YT_REGEX.test(text)) {
          this._lastClipboard = text;
          const input = document.getElementById('urlInput');
          if (input.value.trim() !== text) {
            input.value = text;
            this.fetchInfo(true); // silent=true: suppress empty-URL toast
          }
        }
      } catch { /* clipboard permission denied or not available */ }
    };

    // Check on window focus (user switches to app)
    window.addEventListener('focus', checkClipboard);

    // Also poll every 2s while app is running (catches clipboard changes mid-session)
    this._clipboardTimer = setInterval(checkClipboard, 2000);

    // Do one check immediately on startup
    checkClipboard();
  }

  /* ─── Fetch ─── */
  async fetchInfo(silent = false) {
    const raw = document.getElementById('urlInput').value.trim();
    if (!raw) { if (!silent) this.toast('Paste a YouTube URL first.', 'error'); return; }

    const btn = document.getElementById('fetchBtn');
    btn.querySelector('span').textContent = 'Fetching…';
    btn.disabled = true;

    // Hide previous result
    document.getElementById('videoCard').classList.add('hidden');
    document.getElementById('fetchProgress').classList.remove('hidden');
    document.getElementById('fetchProgressLabel').textContent = 'Fetching video information…';

    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Request timed out. Check your connection.')), 14000));
    try {
      const info = await Promise.race([window.electronAPI.getVideoInfo(raw), timeout]);
      this.currentUrl  = raw;
      this.currentInfo = info;

      // Auto Start: skip video card, directly download with auto-start settings
      if (this.autoStart) {
        const item = {
          id:      ++this._dlIdCounter,
          url:     this.currentUrl,
          info:    { ...info },
          quality: this.autoStartQuality,
          format:  this.autoStartFormat,
          title:   info.title || 'Unknown',
          thumb:   info.thumbnail || '',
        };
        // Clear input so same URL isn't re-triggered by clipboard monitor
        document.getElementById('urlInput').value = '';
        this._lastClipboard = raw;
        this.currentUrl  = '';
        this.currentInfo = null;
        if (!this.isDownloading) {
          this.executeDownload(item).catch(() => {});
        } else {
          this.downloadQueue.push(item);
          this.renderQueueSection();
          this.toast('Added to queue (auto-start).', 'success');
        }
        return;
      }

      this.showVideoCard(info);
    } catch (err) {
      this.toast(err.message || 'Failed to fetch video info.', 'error');
    } finally {
      document.getElementById('fetchProgress').classList.add('hidden');
      btn.querySelector('span').textContent = 'Snapy!';
      btn.disabled = false;
    }
  }

  showVideoCard(info) {
    document.getElementById('videoThumb').src           = info.thumbnail;
    document.getElementById('videoTitle').textContent   = info.title;
    document.getElementById('videoAuthor').textContent  = info.author;
    document.getElementById('videoDurationBadge').textContent = this.fmtDuration(info.duration);
    document.getElementById('videoCard').classList.remove('hidden');
    document.getElementById('videoCard').classList.add('fadein');
    setTimeout(() => document.getElementById('videoCard').classList.remove('fadein'), 300);
  }

  /* ─── Start Download ─── */
  async startDownload() {
    if (!this.currentUrl) { this.toast('Fetch a video first.', 'error'); return; }
    const item = this._makeQueueItem();
    await this.executeDownload(item);
  }

  /* ─── Queue ─── */
  addCurrentToQueue() {
    if (!this.currentUrl) { this.toast('Fetch a video first.', 'error'); return; }
    const item = this._makeQueueItem();
    this.downloadQueue.push(item);
    this.renderQueueSection();
    this.toast('Added to queue!', 'success');
    // Clear the current fetch
    document.getElementById('videoCard').classList.add('hidden');
    document.getElementById('urlInput').value = '';
    this.currentUrl = '';
    this.currentInfo = null;
    // Auto-start if not currently downloading
    if (!this.isDownloading) this.processQueue();
  }

  _makeQueueItem() {
    return {
      id:      ++this._dlIdCounter,
      url:     this.currentUrl,
      info:    { ...this.currentInfo },
      quality: this.selectedQuality,
      format:  this.selectedFormat,
      title:   this.currentInfo?.title || 'Unknown',
      thumb:   this.currentInfo?.thumbnail || '',
    };
  }

  async processQueue() {
    if (this.downloadQueue.length === 0) { this.isDownloading = false; return; }
    this.isDownloading = true;
    const next = this.downloadQueue.shift();
    this.renderQueueSection();
    await this.executeDownload(next).catch(() => {});
    this.processQueue();
  }

  async executeDownload(qItem) {
    const { id, url, info, quality, format, title, thumb } = qItem;

    const dlItem = { id, title, thumb, url, percent: 0, status: 'active', type: format === 'audio' ? 'audio' : 'video', speed: '', eta: '' };
    this.sessionDownloads.unshift(dlItem);
    this.renderDownloadsList();

    // Hide video card while downloading
    document.getElementById('videoCard').classList.add('hidden');
    document.getElementById('downloadBtn').disabled = true;
    this._isPaused = false;

    try {
      const result = await window.electronAPI.downloadVideo(url, { quality, format, videoInfo: info });
      dlItem.status   = 'completed';
      dlItem.percent  = 100;
      dlItem.size     = result.size;
      dlItem.filename = result.filename;
      dlItem.type     = result.type || dlItem.type;

      document.getElementById('downloadBtn').disabled = false;
      this.toast('Download complete!', 'success');
    } catch (err) {
      dlItem.status = err.message?.includes('cancelled') ? 'cancelled' : 'failed';
      document.getElementById('downloadBtn').disabled = false;
      if (dlItem.status !== 'cancelled') this.toast(err.message || 'Download failed.', 'error');
      else this.toast('Download cancelled.', 'error');
    } finally {
      this.trimSessionDownloads();
      this.renderDownloadsList();
      this.loadGallery();
    }
  }

  trimSessionDownloads() {
    const completed = this.sessionDownloads.filter(d => d.status !== 'active');
    const active    = this.sessionDownloads.filter(d => d.status === 'active');
    const trimmed   = completed.slice(0, ITEMS_PER_PAGE);
    this.sessionDownloads = [...active, ...trimmed];
  }

  async cancelDownload() {
    await window.electronAPI.cancelDownload();
  }
  clearCompleted() {
    this.sessionDownloads = this.sessionDownloads.filter(d => d.status === 'active');
    this.renderDownloadsList();
  }
  clearQueue() {
    this.downloadQueue = [];
    this.renderQueueSection();
  }

  /* ─── Progress handlers ─── */
  handleProgress(data) {
    const pct    = data.percent || 0;
    const active = this.sessionDownloads.find(d => d.status === 'active');
    if (!active) return;

    active.percent = pct;
    active.speed   = data.speed || '';
    active.eta     = data.eta   || '';

    const el = document.querySelector(`.dl-item[data-dl-id="${active.id}"]`);
    if (el) {
      const fill = el.querySelector('.dl-bar-fill');
      const pct2 = el.querySelector('.dl-pct');
      const meta = el.querySelector('.dl-speed-eta');
      if (fill) fill.style.width = `${pct}%`;
      if (pct2) pct2.textContent = `${pct}%`;
      if (meta) meta.textContent = [data.speed, data.eta ? `ETA ${data.eta}` : ''].filter(Boolean).join(' · ');
    }
  }

  handleStatus(status) {
    if (!status) return;
    // Update the active dl-item's status text if visible
    const active = this.sessionDownloads.find(d => d.status === 'active');
    if (!active) return;
    const el = document.querySelector(`.dl-item[data-dl-id="${active.id}"] .dl-speed-eta`);
    if (el && !active.speed) el.textContent = status;
  }

  /* ─── Load recent downloads from storage ─── */
  async loadRecentDownloads() {
    try {
      const videos = await window.electronAPI.getVideos();
      const recent = videos.slice(0, ITEMS_PER_PAGE);
      // Only add if not already in session
      const sessionIds = new Set(this.sessionDownloads.map(d => d.filename));
      for (const v of recent) {
        if (!sessionIds.has(v.filename)) {
          this.sessionDownloads.push({
            id:       ++this._dlIdCounter,
            title:    v.title || v.filename,
            thumb:    v.thumbnail || '',
            url:      v.url || '',
            percent:  100,
            status:   'completed',
            size:     v.size || 0,
            filename: v.filename,
            type:     v.type || 'video',
            speed:    '',
            eta:      '',
          });
        }
      }
      this.trimSessionDownloads();
      this.renderDownloadsList();
    } catch {}
  }

  /* ─── Render downloads list ─── */
  renderDownloadsList() {
    const list  = document.getElementById('downloadsList');
    const empty = document.getElementById('downloadsEmpty');

    const active    = this.sessionDownloads.filter(d => d.status === 'active');
    const completed = this.sessionDownloads.filter(d => d.status !== 'active');

    const countEl = document.getElementById('activeCount');
    if (active.length > 0) {
      countEl.textContent = `${active.length} active`; countEl.classList.remove('hidden');
    } else { countEl.classList.add('hidden'); }

    if (this.sessionDownloads.length === 0) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    // Only rebuild if structure changed, otherwise use in-place updates
    const all = [...active, ...completed].slice(0, ITEMS_PER_PAGE);
    const existingIds = new Set([...list.querySelectorAll('.dl-item')].map(el => el.dataset.dlId));
    const newIds = new Set(all.map(d => String(d.id)));

    // Remove items no longer in list
    existingIds.forEach(id => {
      if (!newIds.has(id)) list.querySelector(`.dl-item[data-dl-id="${id}"]`)?.closest('.dl-wrapper')?.remove();
    });

    all.forEach((dl, idx) => {
      const existing = list.querySelector(`.dl-item[data-dl-id="${dl.id}"]`);
      if (existing && dl.status !== 'completed' && existing.dataset.status === dl.status) return; // skip unchanged
      if (existing) existing.closest('.dl-wrapper')?.remove();
      list.insertBefore(this.buildDlItem(dl), list.children[idx] || null);
    });
  }

  buildDlItem(dl) {
    const isActive    = dl.status === 'active';
    const isCompleted = dl.status === 'completed';
    const isFailed    = dl.status === 'failed';
    const isCancelled = dl.status === 'cancelled';

    const wrapper = document.createElement('div');
    wrapper.className = 'dl-wrapper';

    // Delete zone (behind item — visual only, deletion triggered by drag release)
    const deleteZone = document.createElement('div');
    deleteZone.className = 'dl-delete-zone';
    deleteZone.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    wrapper.appendChild(deleteZone);

    const item = document.createElement('div');
    item.className = `dl-item${isActive ? ' active-dl' : ''}`;
    item.setAttribute('data-dl-id', dl.id);
    item.setAttribute('data-status', dl.status);

    const thumbHtml = dl.thumb
      ? `<div class="dl-thumb-wrap"><img src="${dl.thumb}" class="dl-thumb" alt=""></div>`
      : `<div class="dl-thumb-wrap"><div class="dl-thumb-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polygon points="5 3 19 12 5 21 5 3"/></svg></div></div>`;

    const typeBadge = `<span class="dl-type-badge ${dl.type || 'video'}">${dl.type === 'audio' ? 'Audio' : 'Video'}</span>`;

    let rightHtml = '';
    if (isActive) {
      rightHtml = `
        <div class="dl-right">
          <div class="dl-dl-controls">
            <button class="dl-ctrl-btn pause" title="Pause">
              ${this._pauseIcon()}
            </button>
            <button class="dl-ctrl-btn cancel" title="Cancel">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>`;
    } else if (isCompleted) {
      rightHtml = `
        <div class="dl-right">
          <span class="dl-size">${this.fmtSize(dl.size)}</span>
          <div class="dl-actions">
            <button class="dl-act play" title="${dl.type === 'audio' ? 'Play Audio' : 'Play Video'}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </button>
            <button class="dl-act folder" title="Show in Finder">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            </button>
            <button class="dl-act copy-link" title="Copy YouTube URL">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button class="dl-act view-yt" title="View on YouTube">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46a2.78 2.78 0 0 0-1.95 1.96A29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58A2.78 2.78 0 0 0 3.41 19.6C5.12 20 12 20 12 20s6.88 0 8.59-.46a2.78 2.78 0 0 0 1.95-1.95A29 29 0 0 0 23 12a29 29 0 0 0-.46-5.58z"/><polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02" fill="currentColor" stroke="none"/></svg>
            </button>
          </div>
        </div>`;
    } else {
      const statusColor = isFailed ? 'color:var(--red)' : 'color:var(--text3)';
      const statusText  = isFailed ? 'Failed' : 'Cancelled';
      rightHtml = `<div class="dl-right"><span class="dl-size" style="${statusColor}">${statusText}</span></div>`;
    }

    item.innerHTML = `
      ${thumbHtml}
      <div class="dl-body">
        <div class="dl-title">${dl.title}</div>
        <div class="dl-meta">
          ${typeBadge}
          ${isActive ? `<span class="dl-speed-eta">${[dl.speed, dl.eta ? `ETA ${dl.eta}` : ''].filter(Boolean).join(' · ')}</span>` : ''}
        </div>
        ${isActive ? `
        <div class="dl-progress-row">
          <div class="dl-bar"><div class="dl-bar-fill" style="width:${dl.percent}%"></div></div>
          <span class="dl-pct">${dl.percent}%</span>
        </div>` : ''}
      </div>
      ${rightHtml}
    `;

    // Bind buttons
    if (isCompleted) {
      item.querySelector('.dl-act.play')?.addEventListener('click', () => {
        if (dl.filename) window.electronAPI.openFile(dl.filename);
      });
      item.querySelector('.dl-act.folder')?.addEventListener('click', () => {
        if (dl.filename) window.electronAPI.showFileInFolder(dl.filename);
        else window.electronAPI.openOutputFolder();
      });
      item.querySelector('.dl-act.copy-link')?.addEventListener('click', () => {
        navigator.clipboard.writeText(dl.url || '').then(() => this.toast('Link copied!', 'success'));
      });
      item.querySelector('.dl-act.view-yt')?.addEventListener('click', () => {
        if (dl.url) window.electronAPI.openExternal(dl.url);
      });
    }
    if (isActive) {
      const pauseBtn = item.querySelector('.dl-ctrl-btn.pause');
      let paused = false;
      pauseBtn?.addEventListener('click', () => {
        if (paused) {
          window.electronAPI.resumeDownload(); paused = false;
          pauseBtn.innerHTML = this._pauseIcon(); pauseBtn.classList.remove('resume');
        } else {
          window.electronAPI.pauseDownload(); paused = true;
          pauseBtn.innerHTML = this._resumeIcon(); pauseBtn.classList.add('resume');
        }
      });
      item.querySelector('.dl-ctrl-btn.cancel')?.addEventListener('click', () => window.electronAPI.cancelDownload());
    }

    // Right-click context menu
    item.addEventListener('contextmenu', (e) => { e.preventDefault(); this.showItemContextMenu(e, dl); });

    // Drag-to-delete (swipe left)
    this.setupDragToDelete(item, wrapper, dl);

    wrapper.appendChild(item);
    return wrapper;
  }

  setupDragToDelete(itemEl, wrapper, dl) {
    let startX = 0, currentX = 0, dragging = false;
    const THRESHOLD = 80; // drag this far left to trigger delete

    itemEl.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startX = e.clientX; dragging = true; currentX = 0;
      itemEl.style.transition = 'none';
      itemEl.setPointerCapture(e.pointerId);
    });

    itemEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (dx >= 0) return;
      currentX = dx; // no cap — let it slide freely so delete zone fully reveals
      itemEl.style.transform = `translateX(${currentX}px)`;
    });

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      if (currentX < -THRESHOLD) {
        // Past threshold — animate out and delete
        itemEl.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
        itemEl.style.transform = `translateX(-110%)`;
        itemEl.style.opacity   = '0';
        setTimeout(() => {
          this.sessionDownloads = this.sessionDownloads.filter(d => d.id !== dl.id);
          this.renderDownloadsList();
        }, 200);
      } else {
        // Snap back
        itemEl.style.transition = 'transform 0.2s ease';
        itemEl.style.transform  = 'translateX(0)';
      }
    };
    itemEl.addEventListener('pointerup',     endDrag);
    itemEl.addEventListener('pointercancel', endDrag);
  }

  showItemContextMenu(e, dl) {
    this.closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.id = 'ctxMenu';

    const isCompleted = dl.status === 'completed';
    const isAudio     = dl.type === 'audio';

    menu.innerHTML = `
      ${isCompleted ? `
      <button class="ctx-item" id="ctxPlay">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        ${isAudio ? 'Play Audio' : 'Play Video'}
      </button>
      <button class="ctx-item" id="ctxFolder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        Open in Folder
      </button>` : ''}
      ${dl.url ? `
      <button class="ctx-item" id="ctxCopy">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy YouTube Link
      </button>
      <button class="ctx-item" id="ctxYT">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        View on YouTube
      </button>` : ''}
      ${dl.url ? `
      <button class="ctx-item" id="ctxRedownload">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        Re-download
      </button>` : ''}
      <div class="ctx-sep"></div>
      <button class="ctx-item" id="ctxRemoveList">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        Remove from list
      </button>
      ${isCompleted && dl.filename ? `
      <button class="ctx-item danger" id="ctxDeleteFile">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        Delete file
      </button>` : ''}
    `;

    menu.style.left = `${Math.min(e.clientX, window.innerWidth - 200)}px`;
    menu.style.top  = `${Math.min(e.clientY, window.innerHeight - 250)}px`;
    document.body.appendChild(menu);

    menu.querySelector('#ctxPlay')?.addEventListener('click', () => { if (dl.filename) window.electronAPI.openFile(dl.filename); this.closeContextMenu(); });
    menu.querySelector('#ctxFolder')?.addEventListener('click', () => {
      if (dl.filename) window.electronAPI.showFileInFolder(dl.filename);
      else window.electronAPI.openOutputFolder();
      this.closeContextMenu();
    });
    menu.querySelector('#ctxCopy')?.addEventListener('click', () => { navigator.clipboard.writeText(dl.url); this.toast('Link copied!', 'success'); this.closeContextMenu(); });
    menu.querySelector('#ctxYT')?.addEventListener('click', () => { window.electronAPI.openExternal(dl.url); this.closeContextMenu(); });
    menu.querySelector('#ctxRedownload')?.addEventListener('click', () => {
      document.getElementById('urlInput').value = dl.url;
      this.navigate('downloader');
      this.closeContextMenu();
      this.fetchInfo();
    });
    menu.querySelector('#ctxRemoveList')?.addEventListener('click', () => {
      this.sessionDownloads = this.sessionDownloads.filter(d => d.id !== dl.id);
      this.renderDownloadsList();
      this.closeContextMenu();
    });
    menu.querySelector('#ctxDeleteFile')?.addEventListener('click', async () => {
      this.closeContextMenu();
      if (dl.filename) {
        await window.electronAPI.trashFile(dl.filename);
        this.sessionDownloads = this.sessionDownloads.filter(d => d.id !== dl.id);
        this.renderDownloadsList();
        this.loadGallery();
        this.toast('File moved to trash.', 'success');
      }
    });

    const close = (ev) => {
      if (!menu.contains(ev.target)) { this.closeContextMenu(); document.removeEventListener('click', close); }
    };
    setTimeout(() => document.addEventListener('click', close), 50);
  }

  closeContextMenu() { document.getElementById('ctxMenu')?.remove(); }

  /* ─── Queue section render ─── */
  renderQueueSection() {
    const section = document.getElementById('queueSection');
    const list    = document.getElementById('queueList');
    const badge   = document.getElementById('queueCount');

    if (this.downloadQueue.length === 0) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    badge.textContent = this.downloadQueue.length;
    list.innerHTML = '';

    this.downloadQueue.forEach(item => {
      const el = document.createElement('div');
      el.className = 'queue-item';
      el.innerHTML = `
        ${item.thumb ? `<img src="${item.thumb}" class="queue-item-thumb" alt="">` : ''}
        <span class="queue-item-title">${item.title}</span>
        <span class="queue-item-badge">${item.format?.toUpperCase()}</span>
      `;
      list.appendChild(el);
    });
  }

  /* ═══ GALLERY ═════════════════════════════════ */
  bindGallery() {
    document.getElementById('gallerySearch').addEventListener('input', (e) => {
      this._gallerySearch = e.target.value; this._galleryPage = 1; this.renderGalleryFromCache();
    });
    document.getElementById('openGalleryFolderBtn').addEventListener('click', () => window.electronAPI.openOutputFolder());
    document.querySelectorAll('.g-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.g-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._galleryFilter = btn.dataset.filter;
        this._galleryPage   = 1;
        this.renderGalleryFromCache();
      });
    });
    document.getElementById('gallerySort').addEventListener('change', (e) => {
      this._gallerySort = e.target.value; this._galleryPage = 1; this.renderGalleryFromCache();
    });
    document.getElementById('galPrevBtn').addEventListener('click', () => { this._galleryPage--; this.renderGalleryFromCache(); });
    document.getElementById('galNextBtn').addEventListener('click', () => { this._galleryPage++; this.renderGalleryFromCache(); });
  }

  async loadGallery() {
    try {
      this._galleryAll = await window.electronAPI.getVideos();
      this.renderGalleryFromCache();
    } catch {}
  }

  renderGalleryFromCache() {
    let videos = [...this._galleryAll];

    // Filter by type
    if (this._galleryFilter === 'video') videos = videos.filter(v => v.type !== 'audio');
    if (this._galleryFilter === 'audio') videos = videos.filter(v => v.type === 'audio');

    // Filter by search
    if (this._gallerySearch) {
      const q = this._gallerySearch.toLowerCase();
      videos = videos.filter(v => (v.title || v.filename || '').toLowerCase().includes(q));
    }

    // Sort
    const s = this._gallerySort;
    if (s === 'date-desc')     videos.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
    if (s === 'date-asc')      videos.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
    if (s === 'name-asc')      videos.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    if (s === 'name-desc')     videos.sort((a, b) => (b.title || '').localeCompare(a.title || ''));
    if (s === 'size-desc')     videos.sort((a, b) => (b.size || 0) - (a.size || 0));
    if (s === 'duration-desc') videos.sort((a, b) => (b.duration || 0) - (a.duration || 0));

    // Pagination
    const total     = videos.length;
    const pages     = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
    this._galleryPage = Math.max(1, Math.min(this._galleryPage, pages));
    const start = (this._galleryPage - 1) * ITEMS_PER_PAGE;
    const paged = videos.slice(start, start + ITEMS_PER_PAGE);

    this.renderGallery(paged);

    // Pagination controls
    const pag = document.getElementById('galleryPagination');
    const lbl = document.getElementById('galPageLabel');
    const prev = document.getElementById('galPrevBtn');
    const next = document.getElementById('galNextBtn');
    if (pages > 1) {
      pag.classList.remove('hidden');
      lbl.textContent = `Page ${this._galleryPage} of ${pages}`;
      prev.disabled = this._galleryPage <= 1;
      next.disabled = this._galleryPage >= pages;
    } else {
      pag.classList.add('hidden');
    }
  }

  renderGallery(videos) {
    const tbody = document.getElementById('galleryTableBody');
    const empty = document.getElementById('galleryEmpty');
    tbody.innerHTML = '';

    if (!videos || videos.length === 0) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');

    videos.forEach(v => {
      const tr = document.createElement('tr');
      const thumbHtml = v.thumbnail
        ? `<div class="g-thumb-wrap"><img src="${v.thumbnail}" class="g-thumb" alt=""></div>`
        : `<div class="g-thumb-wrap"><div class="g-thumb-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polygon points="5 3 19 12 5 21 5 3"/></svg></div></div>`;

      const type    = v.type || 'video';
      const typeLabel = type === 'audio' ? 'Audio' : 'Video';
      const ext     = v.filename?.split('.').pop()?.toUpperCase() || '';

      tr.innerHTML = `
        <td>${thumbHtml}</td>
        <td>
          <div class="g-row-name">${v.title || v.filename}</div>
          <div class="g-row-meta">${ext}${v.filename && v.filename !== v.title ? '' : ''}</div>
        </td>
        <td><span class="g-type-badge ${type}">${typeLabel}</span></td>
        <td>${this.fmtDuration(v.duration)}</td>
        <td>${this.fmtSize(v.size)}</td>
        <td><span class="g-date">${v.dateAdded ? this.fmtDate(v.dateAdded) : '—'}</span></td>
        <td>
          <button class="row-act-btn" title="Options">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
          </button>
        </td>
      `;

      tr.querySelector('.row-act-btn').addEventListener('click', (e) => {
        e.stopPropagation(); this.showGalleryRowMenu(e, v);
      });
      tr.addEventListener('contextmenu', (e) => { e.preventDefault(); this.showGalleryRowMenu(e, v); });

      // Drag-to-delete on gallery rows
      this.setupGalleryRowDrag(tr, v);

      tbody.appendChild(tr);
    });
  }

  setupGalleryRowDrag(row, v) {
    let startX = 0, currentX = 0, dragging = false;
    const THRESH = 80;

    row.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      startX = e.clientX; dragging = true; currentX = 0;
      row.style.transition = 'none';
    });
    document.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (dx < 0) { currentX = Math.max(-THRESH, dx); row.style.transform = `translateX(${currentX}px)`; row.style.background = 'rgba(255,0,0,0.08)'; }
    });
    const endRow = async () => {
      if (!dragging) return; dragging = false;
      row.style.transition = 'transform 0.2s ease, background 0.2s ease';
      if (currentX < -THRESH / 2) {
        row.style.transform = 'translateX(-100%)';
        row.style.opacity = '0';
        await window.electronAPI.deleteVideo(v.filename);
        this.loadGallery();
        this.toast('Removed from list.', 'success');
      } else {
        row.style.transform = 'translateX(0)'; row.style.background = '';
      }
    };
    document.addEventListener('pointerup', endRow);
  }

  showGalleryRowMenu(e, v) {
    this.closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu'; menu.id = 'ctxMenu';
    const isAudio = v.type === 'audio';
    menu.innerHTML = `
      <button class="ctx-item" id="gctxPlay">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        ${isAudio ? 'Play Audio' : 'Play Video'}
      </button>
      <button class="ctx-item" id="gctxFolder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        Open in Folder
      </button>
      ${v.url ? `
      <button class="ctx-item" id="gctxCopy">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy YouTube Link
      </button>
      <button class="ctx-item" id="gctxYT">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        View on YouTube
      </button>
      <button class="ctx-item" id="gctxRedownload">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        Re-download
      </button>` : ''}
      <div class="ctx-sep"></div>
      <button class="ctx-item" id="gctxRemove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        Remove from list
      </button>
      <button class="ctx-item danger" id="gctxDeleteFile">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        Delete file
      </button>
    `;
    menu.style.left = `${Math.min(e.clientX, window.innerWidth - 200)}px`;
    menu.style.top  = `${Math.min(e.clientY, window.innerHeight - 280)}px`;
    document.body.appendChild(menu);

    menu.querySelector('#gctxPlay')?.addEventListener('click', () => { window.electronAPI.openFile(v.filename); this.closeContextMenu(); });
    menu.querySelector('#gctxFolder')?.addEventListener('click', () => {
      if (v.filename) window.electronAPI.showFileInFolder(v.filename);
      else window.electronAPI.openOutputFolder();
      this.closeContextMenu();
    });
    menu.querySelector('#gctxCopy')?.addEventListener('click', () => { if (v.url) navigator.clipboard.writeText(v.url); this.toast('Link copied!', 'success'); this.closeContextMenu(); });
    menu.querySelector('#gctxYT')?.addEventListener('click', () => { if (v.url) window.electronAPI.openExternal(v.url); this.closeContextMenu(); });
    menu.querySelector('#gctxRedownload')?.addEventListener('click', () => {
      if (v.url) { document.getElementById('urlInput').value = v.url; this.navigate('downloader'); this.fetchInfo(); }
      this.closeContextMenu();
    });
    menu.querySelector('#gctxRemove')?.addEventListener('click', async () => {
      await window.electronAPI.deleteVideo(v.filename); this.loadGallery(); this.closeContextMenu(); this.toast('Removed.', 'success');
    });
    menu.querySelector('#gctxDeleteFile')?.addEventListener('click', async () => {
      await window.electronAPI.trashFile(v.filename); this.loadGallery(); this.closeContextMenu(); this.toast('File moved to trash.', 'success');
    });

    const close = (ev) => {
      if (!menu.contains(ev.target)) { this.closeContextMenu(); document.removeEventListener('click', close); }
    };
    setTimeout(() => document.addEventListener('click', close), 50);
  }

  /* ═══ SETTINGS ════════════════════════════════ */
  bindSettings() {
    document.getElementById('changePathBtn').addEventListener('click', async () => {
      const p = await window.electronAPI.openFolder();
      if (p) { document.getElementById('settingsOutputPath').textContent = p; this.setOutputPathLabel(p); }
    });
    document.getElementById('saveSettingsBtn').addEventListener('click', () => this.saveSettings());
    document.querySelectorAll('[data-pref]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll(`[data-pref="${btn.dataset.pref}"]`).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Auto Start toggle
    const autoStartToggle = document.getElementById('autoStartToggle');
    const autoStartOptions = document.getElementById('autoStartOptions');
    autoStartToggle?.addEventListener('change', () => {
      this.autoStart = autoStartToggle.checked;
      if (this.autoStart) {
        autoStartOptions?.classList.remove('hidden');
      } else {
        autoStartOptions?.classList.add('hidden');
      }
    });

    // Auto Start quality pills
    document.querySelectorAll('[data-as-quality]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-as-quality]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.autoStartQuality = btn.dataset.asQuality;
      });
    });

    // Auto Start format pills
    document.querySelectorAll('[data-as-format]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-as-format]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.autoStartFormat = btn.dataset.asFormat;
      });
    });
  }

  async loadSettings() {
    try {
      const [prefs, outputPath] = await Promise.all([window.electronAPI.getPreferences(), window.electronAPI.getOutputPath()]);
      document.getElementById('settingsOutputPath').textContent = outputPath;

      const fmtBtn = document.querySelector(`[data-pref="format"][data-value="${prefs.format}"]`);
      const qBtn   = document.querySelector(`[data-pref="quality"][data-value="${prefs.quality}"]`);
      if (fmtBtn) { document.querySelectorAll('[data-pref="format"]').forEach(b => b.classList.remove('active')); fmtBtn.classList.add('active'); }
      if (qBtn)   { document.querySelectorAll('[data-pref="quality"]').forEach(b => b.classList.remove('active')); qBtn.classList.add('active'); }

      document.getElementById('autoUpdateToggle').checked = prefs.autoUpdate !== false;
      this.selectedFormat  = prefs.format  || 'mp4';
      this.selectedQuality = prefs.quality || 'best';

      // Auto Start
      this.autoStart        = prefs.autoStart        || false;
      this.autoStartQuality = prefs.autoStartQuality || 'best';
      this.autoStartFormat  = prefs.autoStartFormat  || 'mp4';

      const autoStartToggle  = document.getElementById('autoStartToggle');
      const autoStartOptions = document.getElementById('autoStartOptions');
      if (autoStartToggle) autoStartToggle.checked = this.autoStart;
      if (this.autoStart) autoStartOptions?.classList.remove('hidden');
      else                autoStartOptions?.classList.add('hidden');

      // Restore auto-start quality pill
      const asQBtn = document.querySelector(`[data-as-quality="${this.autoStartQuality}"]`);
      if (asQBtn) { document.querySelectorAll('[data-as-quality]').forEach(b => b.classList.remove('active')); asQBtn.classList.add('active'); }

      // Restore auto-start format pill
      const asFBtn = document.querySelector(`[data-as-format="${this.autoStartFormat}"]`);
      if (asFBtn) { document.querySelectorAll('[data-as-format]').forEach(b => b.classList.remove('active')); asFBtn.classList.add('active'); }

      // Sync download pills
      const dlFmt = document.querySelector(`#formatPills [data-format="${this.selectedFormat}"]`);
      if (dlFmt) { document.querySelectorAll('#formatPills .pill').forEach(b => b.classList.remove('active')); dlFmt.classList.add('active'); }
      const dlQ = document.querySelector(`#qualityPills [data-quality="${this.selectedQuality}"]`);
      if (dlQ)  { document.querySelectorAll('#qualityPills .pill').forEach(b => b.classList.remove('active')); dlQ.classList.add('active'); }
    } catch {}
  }

  async saveSettings() {
    try {
      const fmt  = document.querySelector('[data-pref="format"].active')?.dataset.value  || 'mp4';
      const q    = document.querySelector('[data-pref="quality"].active')?.dataset.value || 'best';
      const asQ  = document.querySelector('[data-as-quality].active')?.dataset.asQuality  || 'best';
      const asFmt = document.querySelector('[data-as-format].active')?.dataset.asFormat   || 'mp4';
      const autoStart = document.getElementById('autoStartToggle')?.checked || false;

      await window.electronAPI.setPreferences({
        format: fmt, quality: q,
        autoUpdate:       document.getElementById('autoUpdateToggle').checked,
        autoStart,
        autoStartQuality: asQ,
        autoStartFormat:  asFmt,
      });

      this.selectedFormat   = fmt;
      this.selectedQuality  = q;
      this.autoStart        = autoStart;
      this.autoStartQuality = asQ;
      this.autoStartFormat  = asFmt;

      // Sync download pills with new defaults
      const dlFmt = document.querySelector(`#formatPills [data-format="${fmt}"]`);
      if (dlFmt) { document.querySelectorAll('#formatPills .pill').forEach(b => b.classList.remove('active')); dlFmt.classList.add('active'); }
      const dlQ = document.querySelector(`#qualityPills [data-quality="${q}"]`);
      if (dlQ)  { document.querySelectorAll('#qualityPills .pill').forEach(b => b.classList.remove('active')); dlQ.classList.add('active'); }

      this.toast('Settings saved!', 'success');
    } catch { this.toast('Failed to save settings.', 'error'); }
  }

  /* ═══ HELPERS ═════════════════════════════════ */
  fmtDuration(secs) {
    if (!secs) return '—';
    const s = parseInt(secs, 10), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    return `${m}:${String(sec).padStart(2,'0')}`;
  }
  fmtSize(bytes) {
    if (!bytes) return '—';
    const b = parseInt(bytes, 10);
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
    if (b >= 1048576)    return (b / 1048576).toFixed(0)    + ' MB';
    if (b >= 1024)       return (b / 1024).toFixed(0)       + ' KB';
    return b + ' B';
  }
  fmtDate(iso) {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  toast(msg, type = 'success') {
    const t = document.createElement('div');
    t.className = `toast ${type}`; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => {
      t.style.animation = 'slideOutRight 0.25s cubic-bezier(0.4,0,0.2,1) forwards';
      setTimeout(() => t.remove(), 280);
    }, 3000);
  }
}

document.addEventListener('DOMContentLoaded', () => new SnapyYT());
