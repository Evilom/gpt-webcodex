const path = require('node:path');
const { BrowserWindow, ipcMain, screen } = require('electron');

// A child window paints above native ChatGPT without resizing or hiding it.
class ShellPopover {
  constructor(parent) {
    this.parent = parent;
    this.current = null;
    this.window = null;
    this.disposed = false;
    this.onEvent = (event, payload = {}) => {
      if (event.sender !== this.window?.webContents || event.senderFrame !== event.sender.mainFrame) return;
      if (!this.current || payload.token !== this.current.token) return;
      if (payload.type === 'ready') {
        if (!parent.isVisible()) return this.close('outside');
        if (!this.window.isVisible()) this.window.show();
      } else if (payload.type === 'close') this.close('escape');
      else if (payload.type === 'action' && typeof payload.id === 'string') {
        parent.webContents.send('shell-popover:event', { ...payload, key: this.current.key });
      }
    };
    ipcMain.on('shell-popover:event', this.onEvent);
    this.onLayout = () => this.close('layout');
    for (const event of ['move', 'resize', 'hide', 'minimize']) parent.on(event, this.onLayout);
    for (const event of ['did-start-navigation', 'render-process-gone']) parent.webContents.on(event, this.onLayout);
  }

  async update(payload) {
    if (this.disposed) return;
    if (!payload) return this.close('outside');
    if (!['more', 'history'].includes(payload.key) || typeof payload.token !== 'string'
      || typeof payload.html !== 'string' || payload.html.length > 524288) throw new Error('无效的浮层内容。');
    this.current = payload;
    if (!this.window || this.window.isDestroyed()) {
      this.window = new BrowserWindow({
        parent: this.parent, show: false, frame: false, transparent: true,
        resizable: false, movable: false, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, hasShadow: false,
        width: 300, height: 400, title: '超级智囊团 · 快捷面板',
        webPreferences: { preload: path.join(__dirname, 'shellPopoverPreload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false }
      });
      this.window.removeMenu();
      const popup = this.window;
      popup.on('closed', () => {
        if (this.window !== popup) return;
        this.window = null;
        this.close('outside');
      });
      popup.webContents.on('render-process-gone', () => {
        this.close('outside');
        if (!popup.isDestroyed()) popup.destroy();
      });
      this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.window.webContents.on('will-navigate', event => event.preventDefault());
      this.window.on('blur', () => setImmediate(() => {
        // Clicks in the host shell are dismissed by its own click handler;
        // clicks in native ChatGPT are dismissed by its focus event.
        if (!this.disposed && !this.parent.isDestroyed() && !this.parent.isFocused()) this.close('outside');
      }));
      this.loading = this.window.loadFile(path.join(__dirname, '..', 'renderer', 'shell-popover.html'));
    }
    const popup = this.window;
    try { await this.loading; }
    catch (error) {
      if (this.window === popup && !popup.isDestroyed()) popup.destroy();
      throw error;
    }
    if (this.disposed || this.current !== payload || this.window !== popup || popup.isDestroyed()) return;
    const host = this.parent.getContentBounds();
    const work = screen.getDisplayMatching(host).workArea;
    const left = Math.max(host.x, work.x), top = Math.max(host.y, work.y);
    const right = Math.min(host.x + host.width, work.x + work.width);
    const bottom = Math.min(host.y + host.height, work.y + work.height);
    if (right <= left || bottom <= top) return this.close('layout');
    const rect = payload.bounds || {};
    const width = Math.max(1, Math.min(Math.round(Number(rect.width) || 296), right - left));
    const height = Math.max(1, Math.min(Math.round(Number(rect.height) || 400), bottom - top));
    const x = Math.round(Math.max(left, Math.min(right - width, host.x + (Number(rect.x) || 0))));
    const y = Math.round(Math.max(top, Math.min(bottom - height, host.y + (Number(rect.y) || 0))));
    this.window.setBounds({ x, y, width, height }, false);
    this.window.webContents.send('shell-popover:render', { token: payload.token, html: payload.html, theme: payload.theme });
  }

  close(reason = 'outside') {
    const previous = this.current;
    this.current = null;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
    if (previous && !this.parent.isDestroyed() && !this.parent.webContents.isDestroyed()) {
      if (reason === 'escape') this.parent.webContents.focus();
      this.parent.webContents.send('shell-popover:event', { type: 'closed', token: previous.token, key: previous.key, reason });
    }
  }

  dispose() {
    this.disposed = true;
    this.current = null;
    ipcMain.removeListener('shell-popover:event', this.onEvent);
    for (const event of ['move', 'resize', 'hide', 'minimize']) this.parent.removeListener(event, this.onLayout);
    for (const event of ['did-start-navigation', 'render-process-gone']) this.parent.webContents.removeListener(event, this.onLayout);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
  }
}

module.exports = { ShellPopover };
