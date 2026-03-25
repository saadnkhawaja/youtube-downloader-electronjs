const GITHUB_URL = 'https://github.com/saadnkhawaja';
const YT_REGEX   = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?.*v=|shorts\/)|youtu\.be\/).+/i;

class SnapyYT {
  constructor() {
    this.currentUrl      = '';
    this.selectedQuality = 'best';
    this.selectedFormat  = 'mp4';
    this.activeDownloads = [];
    this.completedDownloads = [];

    this.bindTitlebar();
    this.bindNav();
    this.bindDownloader();
    this.bindGallery();
    this.bindSettings();
    this.bindFab();
    this.initTheme();
    this.loadOutputPath();
    this.loadSettings();
    this.loadGallery();

    window.electronAPI.onDownloadProgress((data) => this.handleProgress(data));
  }

  /* ── TITLEBAR ─────────────────────────────── */

  bindTitlebar() {
    document.getElementById('btnMinimize').addEventListener('click', () => {
      window.electronAPI.windowMinimize();
    });
    document.getElementById('btnClose').addEventListener('click', () => {
      window.electronAPI.windowClose();
    });
  }

  /* ── NAVIGATION ───────────────────────────── */

  bindNav() {
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => this.navigate(btn.dataset.page));
    });
  }

  navigate(page) {
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.getElementById(page).classList.add('active');
    document.querySelector(`[data-page="${page}"]`).classList.add('active');
    if (page === 'gallery') this.loadGallery();
  }

  /* ── THEME ────────────────────────────────── */

  initTheme() {
    this.applyTheme(localStorage.getItem('theme') || 'light');
    document.getElementById('themeToggle').addEventListener('click', () => {
      const curr = document.documentElement.getAttribute('data-theme') || 'light';
      this.applyTheme(curr === 'dark' ? 'light' : 'dark');
    });
  }

  applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.getElementById('themeLabel').textContent = 'Light Mode';
    } else {
      document.documentElement.removeAttribute('data-theme');
      document.getElementById('themeLabel').textContent = 'Dark Mode';
    }
    localStorage.setItem('theme', theme);
  }

  /* ── FAB ──────────────────────────────────── */

  bindFab() {
    document.getElementById('fabBtn').addEventListener('click', async () => {
      this.navigate('downloader');
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (YT_REGEX.test(text)) {
          const input = document.getElementById('urlInput');
          input.value = text;
          input.focus();
          this.toast('YouTube URL pasted from clipboard!', 'success');
        }
      } catch {
        document.getElementById('urlInput').focus();
      }
    });
  }

  /* ── GITHUB LINKS ─────────────────────────── */

  bindGithubLinks() {
    ['githubLink', 'githubLink2'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', () => window.electronAPI.openExternal(GITHUB_URL));
    });
  }

  /* ── DOWNLOADER ───────────────────────────── */

  bindDownloader() {
    this.bindGithubLinks();

    document.getElementById('fetchBtn').addEventListener('click', () => this.fetchInfo());
    document.getElementById('urlInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.fetchInfo();
    });

    document.getElementById('downloadBtn').addEventListener('click', () => this.startDownload());

    document.getElementById('folderChipBtn').addEventListener('click', async () => {
      const newPath = await window.electronAPI.openFolder();
      if (newPath) this.setOutputPathLabel(newPath);
    });

    document.getElementById('clearCompletedBtn').addEventListener('click', () => {
      this.completedDownloads = [];
      this.renderDownloadsList();
    });

    document.querySelectorAll('#qualityPills .pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#qualityPills .pill').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedQuality = btn.dataset.quality;
      });
    });

    document.querySelectorAll('#formatPills .pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#formatPills .pill').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedFormat = btn.dataset.format;
      });
    });
  }

  async loadOutputPath() {
    try {
      const p = await window.electronAPI.getOutputPath();
      this.setOutputPathLabel(p);
    } catch {}
  }

  setOutputPathLabel(p) {
    const parts   = p.replace(/\\/g, '/').split('/').filter(Boolean);
    const display = parts.length >= 2 ? parts.slice(-2).join('/') : p;
    document.getElementById('outputPathLabel').textContent = display;
  }

  async fetchInfo() {
    const url = document.getElementById('urlInput').value.trim();
    if (!url) { this.toast('Paste a YouTube URL first.', 'error'); return; }

    const btn = document.getElementById('fetchBtn');
    btn.querySelector('svg + *') && null;
    btn.lastChild.textContent = 'Fetching…';
    btn.disabled = true;

    try {
      const info = await window.electronAPI.getVideoInfo(url);
      this.currentUrl = url;
      this.showVideoCard(info);
    } catch (err) {
      this.toast(err.message || 'Failed to fetch video info.', 'error');
    } finally {
      btn.lastChild.textContent = 'Fetch';
      btn.disabled = false;
    }
  }

  showVideoCard(info) {
    document.getElementById('videoThumb').src          = info.thumbnail;
    document.getElementById('videoTitle').textContent  = info.title;
    document.getElementById('videoAuthor').textContent = `Channel: ${info.author}`;
    document.getElementById('videoDurationBadge').textContent = this.fmtDuration(info.duration);
    document.getElementById('videoCard').classList.remove('hidden');
    document.getElementById('progressCard').classList.add('hidden');
  }

  async startDownload() {
    if (!this.currentUrl) { this.toast('Fetch a video first.', 'error'); return; }

    const title = document.getElementById('videoTitle').textContent;
    const thumb = document.getElementById('videoThumb').src;

    document.getElementById('videoCard').classList.add('hidden');
    document.getElementById('progressCard').classList.remove('hidden');
    document.getElementById('progressTitle').textContent   = 'Downloading…';
    document.getElementById('progressPercent').textContent = '0%';
    document.getElementById('progressBar').style.width     = '0%';
    document.getElementById('progressMeta').textContent    = '';
    document.getElementById('downloadBtn').disabled        = true;

    const dlItem = { name: title, percent: 0, status: 'active', thumb };
    this.activeDownloads.push(dlItem);
    this.renderDownloadsList();

    try {
      const result = await window.electronAPI.downloadVideo(this.currentUrl, {
        quality: this.selectedQuality,
        format:  this.selectedFormat,
      });

      dlItem.status  = 'completed';
      dlItem.percent = 100;
      dlItem.size    = result.size;
      this.completedDownloads.push(dlItem);
      this.activeDownloads = this.activeDownloads.filter((d) => d !== dlItem);

      document.getElementById('progressTitle').textContent   = 'Download Complete!';
      document.getElementById('progressPercent').textContent = '100%';
      document.getElementById('progressBar').style.width     = '100%';
      document.getElementById('downloadBtn').disabled        = false;

      this.toast('Download complete!', 'success');
      this.renderDownloadsList();

      setTimeout(() => {
        document.getElementById('progressCard').classList.add('hidden');
        document.getElementById('urlInput').value = '';
        this.currentUrl = '';
        this.loadGallery();
      }, 2400);
    } catch (err) {
      dlItem.status = 'failed';
      this.activeDownloads = this.activeDownloads.filter((d) => d !== dlItem);
      this.renderDownloadsList();
      document.getElementById('progressCard').classList.add('hidden');
      document.getElementById('videoCard').classList.remove('hidden');
      document.getElementById('downloadBtn').disabled = false;
      this.toast(err.message || 'Download failed.', 'error');
    }
  }

  handleProgress(data) {
    const pct = data.percent || 0;
    document.getElementById('progressBar').style.width     = `${pct}%`;
    document.getElementById('progressPercent').textContent = `${pct}%`;
    if (data.totalSize && data.currentSize) {
      document.getElementById('progressMeta').textContent =
        `${this.fmtSize(data.currentSize)} of ${this.fmtSize(data.totalSize)}`;
    }
    const active = this.activeDownloads[this.activeDownloads.length - 1];
    if (active) { active.percent = pct; this.renderDownloadsList(); }
  }

  renderDownloadsList() {
    const list = document.getElementById('downloadsList');
    const all  = [...this.activeDownloads, ...this.completedDownloads];
    list.innerHTML = '';

    const countEl = document.getElementById('activeCount');
    if (this.activeDownloads.length > 0) {
      countEl.textContent = `${this.activeDownloads.length} Active`;
      countEl.classList.remove('hidden');
    } else {
      countEl.classList.add('hidden');
    }

    all.forEach((dl) => {
      const item = document.createElement('div');
      item.className = 'dl-item';

      const thumbHtml = dl.thumb
        ? `<img src="${dl.thumb}" class="dl-thumb" alt="">`
        : `<div class="dl-thumb-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>`;

      const statusHtml = dl.status === 'completed'
        ? `<span class="dl-status completed">COMPLETED · ${this.fmtSize(dl.size || 0)}</span>`
        : dl.status === 'failed'
        ? `<span class="dl-status" style="color:var(--red)">FAILED</span>`
        : `<span class="dl-status">${dl.percent}%</span>`;

      item.innerHTML = `
        ${thumbHtml}
        <div class="dl-body">
          <div class="dl-name">${dl.name}</div>
          <div class="dl-track"><div class="dl-track-fill" style="width:${dl.percent}%"></div></div>
        </div>
        ${statusHtml}
      `;
      list.appendChild(item);
    });
  }

  /* ── GALLERY ──────────────────────────────── */

  bindGallery() {
    document.getElementById('gallerySearch').addEventListener('input', (e) => {
      this.filterGallery(e.target.value);
    });
    document.getElementById('openGalleryFolderBtn').addEventListener('click', () => {
      window.electronAPI.openOutputFolder();
    });
    document.querySelectorAll('.filter-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  async loadGallery() {
    try {
      const videos = await window.electronAPI.getVideos();
      this.renderGallery(videos);
    } catch {}
  }

  renderGallery(videos) {
    const tbody = document.getElementById('galleryTableBody');
    const empty = document.getElementById('galleryEmpty');
    tbody.innerHTML = '';

    if (!videos || videos.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    videos.forEach((v) => {
      const tr = document.createElement('tr');
      const thumbHtml = v.thumbnail
        ? `<img src="${v.thumbnail}" class="gallery-row-thumb" alt="">`
        : `<div class="gallery-row-thumb-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>`;

      const ext     = v.filename ? v.filename.split('.').pop().toUpperCase() : '';
      const dateStr = v.dateAdded ? this.fmtDate(v.dateAdded) : '—';

      tr.innerHTML = `
        <td>${thumbHtml}</td>
        <td>
          <div class="gallery-row-name">${v.filename || v.title}</div>
          <div class="gallery-row-meta">${ext}</div>
        </td>
        <td>${this.fmtDuration(v.duration)}</td>
        <td>${this.fmtSize(v.size)}</td>
        <td><div class="gallery-row-date">${dateStr}</div></td>
        <td>
          <button class="row-action-btn" data-filename="${v.filename}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
          </button>
        </td>
      `;

      tr.querySelector('.row-action-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.showRowMenu(e, v.filename);
      });

      tbody.appendChild(tr);
    });
  }

  filterGallery(q) {
    document.querySelectorAll('#galleryTableBody tr').forEach((row) => {
      const name = row.querySelector('.gallery-row-name')?.textContent || '';
      row.style.display = name.toLowerCase().includes(q.toLowerCase()) ? '' : 'none';
    });
  }

  showRowMenu(e, filename) {
    document.querySelectorAll('.dropdown-menu').forEach((m) => m.remove());

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu';

    const rect = e.currentTarget.getBoundingClientRect();
    menu.style.top  = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.right - 150}px`;

    menu.innerHTML = `
      <button class="dropdown-item" id="dmOpen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        Open file
      </button>
      <button class="dropdown-item danger" id="dmDelete">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        Delete
      </button>
    `;

    document.body.appendChild(menu);

    menu.querySelector('#dmOpen').addEventListener('click', () => {
      window.electronAPI.openFile(filename);
      menu.remove();
    });

    menu.querySelector('#dmDelete').addEventListener('click', async () => {
      menu.remove();
      await window.electronAPI.deleteVideo(filename);
      this.toast('Video deleted.', 'success');
      this.loadGallery();
    });

    const close = (ev) => {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); }
    };
    setTimeout(() => document.addEventListener('click', close), 10);
  }

  /* ── SETTINGS ─────────────────────────────── */

  bindSettings() {
    document.getElementById('changePathBtn').addEventListener('click', async () => {
      const newPath = await window.electronAPI.openFolder();
      if (newPath) {
        document.getElementById('settingsOutputPath').textContent = newPath;
        this.setOutputPathLabel(newPath);
      }
    });

    document.getElementById('saveSettingsBtn').addEventListener('click', () => this.saveSettings());

    document.querySelectorAll('[data-pref]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pref = btn.dataset.pref;
        document.querySelectorAll(`[data-pref="${pref}"]`).forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  async loadSettings() {
    try {
      const [prefs, outputPath] = await Promise.all([
        window.electronAPI.getPreferences(),
        window.electronAPI.getOutputPath(),
      ]);

      document.getElementById('settingsOutputPath').textContent = outputPath;

      const fmtBtn = document.querySelector(`[data-pref="format"][data-value="${prefs.format}"]`);
      const qBtn   = document.querySelector(`[data-pref="quality"][data-value="${prefs.quality}"]`);

      if (fmtBtn) {
        document.querySelectorAll('[data-pref="format"]').forEach((b) => b.classList.remove('active'));
        fmtBtn.classList.add('active');
      }
      if (qBtn) {
        document.querySelectorAll('[data-pref="quality"]').forEach((b) => b.classList.remove('active'));
        qBtn.classList.add('active');
      }

      document.getElementById('autoUpdateToggle').checked = prefs.autoUpdate !== false;
      this.selectedFormat  = prefs.format  || 'mp4';
      this.selectedQuality = prefs.quality || 'best';
    } catch {}
  }

  async saveSettings() {
    try {
      const fmtActive = document.querySelector('[data-pref="format"].active');
      const qActive   = document.querySelector('[data-pref="quality"].active');
      await window.electronAPI.setPreferences({
        format:     fmtActive?.dataset.value  || 'mp4',
        quality:    qActive?.dataset.value    || 'best',
        autoUpdate: document.getElementById('autoUpdateToggle').checked,
      });
      this.toast('Settings saved!', 'success');
    } catch {
      this.toast('Failed to save settings.', 'error');
    }
  }

  /* ── HELPERS ──────────────────────────────── */

  fmtDuration(secs) {
    if (!secs) return '—';
    const s   = parseInt(secs, 10);
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = s % 60;
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
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  }

  toast(msg, type = 'success') {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => {
      t.style.animation = 'slideOutRight 0.28s cubic-bezier(0.4,0,0.2,1) forwards';
      setTimeout(() => t.remove(), 300);
    }, 3000);
  }
}

document.addEventListener('DOMContentLoaded', () => new SnapyYT());
