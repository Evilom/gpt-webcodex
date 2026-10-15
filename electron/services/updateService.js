'use strict';

const REPOSITORY = 'Evilom/gpt-webcodex';
const RELEASE_PAGE = `https://github.com/${REPOSITORY}/releases/latest`;
const RECHECK_MS = 6 * 60 * 60 * 1000;

function isNewerVersion(candidate, current) {
  if (!/^\d+\.\d+\.\d+$/.test(String(candidate))) return false;
  const a = candidate.split('.').map(Number), b = String(current).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

class UpdateService {
  constructor({ updater, version, packaged, platform = process.platform, fetch, openExternal, onState = () => {}, log }) {
    Object.assign(this, { updater, packaged, platform, fetch, openExternal, onState, log });
    this.state = { current: version, latest: '', stage: 'idle', progress: 0, error: '', checkedAt: 0, manual: platform !== 'win32' || !packaged };
    this.pending = null;
    this.stopped = false;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.setFeedURL({ provider: 'github', owner: 'Evilom', repo: 'gpt-webcodex', private: false });
    updater.on('update-available', (info) => this.set({ latest: info.version, stage: 'available', error: '', checkedAt: Date.now() }));
    updater.on('update-not-available', () => this.set({ latest: '', stage: 'current', error: '', checkedAt: Date.now() }));
    updater.on('download-progress', (info) => this.set({ stage: 'downloading', progress: Math.floor(info.percent) }));
    updater.on('update-downloaded', (info) => this.set({ latest: info.version, stage: 'downloaded', progress: 100, error: '' }));
    updater.on('error', (error) => this.failed(error));
  }

  set(patch) { this.state = { ...this.state, ...patch }; if (!this.stopped) this.onState(this.getState()); }
  getState() { return { ...this.state, releasePage: RELEASE_PAGE }; }
  failed(error) {
    const message = String(error?.message || error);
    const reason = error instanceof TypeError && message === 'fetch failed'
      ? '无法连接 GitHub，请检查网络或代理后重试。'
      : message;
    this.set({ stage: 'error', error: reason.slice(0, 400) });
    this.log.warn('检查或下载助手更新失败', { error: message.slice(0, 400) });
  }
  start() {
    this.stopped = false;
    this.startTimer = setTimeout(() => void this.check(), 15000);
    this.startTimer.unref?.();
    this.timer = setInterval(() => void this.check(), RECHECK_MS);
    this.timer.unref?.();
  }
  stop() { this.stopped = true; clearTimeout(this.startTimer); clearInterval(this.timer); }

  check() {
    if (this.pending) return this.pending;
    if (this.state.stage === 'downloaded') return Promise.resolve(this.getState());
    this.set({ stage: 'checking', error: '' });
    this.pending = Promise.resolve().then(async () => {
      if (!this.state.manual) {
        await this.updater.checkForUpdates();
      } else {
        const response = await this.fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/vnd.github+json' } });
        if (response.status === 404) { this.set({ stage: 'unpublished', checkedAt: Date.now() }); return; }
        let release;
        if ([403, 429].includes(response.status)) {
          // CoS update.ts: GitHub's public latest redirect survives API rate limits.
          const page = await this.fetch(RELEASE_PAGE, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
          const landed = new URL(page.url);
          const prefix = `/${REPOSITORY}/releases/tag/`;
          if (!page.ok || landed.origin !== 'https://github.com' || !landed.pathname.startsWith(prefix)) throw new Error('无法从我们的 Release 页面读取新版');
          release = { tag_name: decodeURIComponent(landed.pathname.slice(prefix.length)) };
        } else {
          if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
          release = await response.json();
        }
        const version = String(release.tag_name || '').replace(/^v/, '');
        if (!/^\d+\.\d+\.\d+$/.test(version) || release.draft || release.prerelease) throw new Error('Release 版本信息无效');
        const newer = isNewerVersion(version, this.state.current);
        this.set({ latest: newer ? version : '', stage: newer ? 'available' : 'current', checkedAt: Date.now() });
      }
    }).catch((error) => this.failed(error)).finally(() => { this.pending = null; });
    return this.pending.then(() => this.getState());
  }

  download() {
    if (this.state.manual) return this.openExternal(RELEASE_PAGE);
    if (this.pending) return this.pending;
    if (this.state.stage !== 'available') throw new Error('请先检查更新，确认有可下载的新版。');
    this.set({ stage: 'downloading', progress: 0, error: '' });
    this.pending = Promise.resolve().then(() => this.updater.downloadUpdate()).catch((error) => this.failed(error)).finally(() => { this.pending = null; });
    return this.pending.then(() => this.getState());
  }

  install() {
    if (this.state.manual || this.state.stage !== 'downloaded') throw new Error('更新尚未下载完成。');
    this.updater.quitAndInstall(false, true);
  }
}

module.exports = { UpdateService, isNewerVersion, REPOSITORY, RELEASE_PAGE, RECHECK_MS };
