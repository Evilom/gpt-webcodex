const { ChatViewController, CHAT_HOME, isChatGptNavigation, isChatConversationUrl } = require('./chatViewController');
const { randomUUID } = require('node:crypto');

const MAX_TABS = 8;
function conversationKey(url) {
  if (!isChatConversationUrl(url)) return '';
  return new URL(url).pathname.match(/(?:^|\/)c\/([^/]+)/)?.[1] || '';
}
function protectedTab(controller) {
  return controller.loading || ['generating', 'interrupted'].includes(controller.streamState.status)
    || Boolean(controller.nativeLogin?.run) || Boolean(controller.login?.returning) || Boolean(controller.authViews?.length);
}
const tabKey = tab => conversationKey(tab.controller.getState().url) || conversationKey(tab.initialUrl);

// Each tab owns a complete controller/WebContents. Only the login session and
// existing local MCP service are shared; switching never navigates a page.
class ChatTabsController {
  constructor({ confirm = async () => false, createController = options => new ChatViewController(options), ...options }) {
    this.options = options;
    this.confirm = confirm;
    this.createController = createController;
    this.tabs = new Map();
    this.activeId = '';
    this.nextId = 0;
    this.insets = { toolbarHeight: options.toolbarHeight };
    this.disposed = false;
    this.prompting = false;
    this.sessionReady = null;
    this.sessionInitialized = false;
  }

  get active() { return this.tabs.get(this.activeId)?.controller; }
  get streamState() { return this.active?.streamState || { status: 'unknown' }; }
  get nativeLogin() { return this.active?.nativeLogin; }
  get toolbarHeight() { return this.active?.toolbarHeight ?? this.options.toolbarHeight; }
  hasRunningWork() { return this.prompting || [...this.tabs.values()].some(tab => protectedTab(tab.controller)); }

  mount() { if (!this.tabs.size) this.openTab(); }

  openTab(url = CHAT_HOME) {
    if (this.disposed) return false;
    if (!isChatGptNavigation(url)) throw new Error('标签只支持 ChatGPT 网页。');
    const key = conversationKey(url);
    const existing = key && [...this.tabs.values()].find(tab => tabKey(tab) === key);
    if (existing) return this.selectTab(existing.id);
    if (this.tabs.size >= MAX_TABS) throw new Error('最多同时保留 8 个标签。请先关闭不用的标签；运行中的标签不会自动关闭。');
    const id = `chat-${++this.nextId}-${randomUUID()}`;
    const tab = { id, initialUrl: url, unread: false, controller: null };
    tab.controller = this.createController({
      ...this.options, initialUrl: url, initializeSession: !this.sessionInitialized, sessionReady: this.sessionReady,
      onState: state => {
        if (this.disposed || !this.tabs.has(id)) return;
        if (isChatGptNavigation(state.url)) tab.initialUrl = state.url;
        const signature = `${state.streamState?.status}:${state.streamState?.event}`;
        if (signature !== tab.streamSignature && id !== this.activeId && (['interrupted', 'render_error', 'renderer_gone', 'asset_error'].includes(state.streamState?.status)
          || state.streamState?.event === 'page-response-finished')) tab.unread = true;
        tab.streamSignature = signature;
        this.emitState();
      },
      onRequestNavigation: request => { void this.requestNavigation(id, request).catch(error => this.reportError(error)); },
      onTabShortcut: input => id === this.activeId && this.handleShortcut(input),
      onNativeFocus: () => { if (id === this.activeId) this.options.onNativeFocus?.(); }
    });
    this.tabs.set(id, tab);
    this.active?.setVisible(false);
    this.activeId = id;
    tab.controller.mount();
    this.sessionInitialized = true;
    this.sessionReady = tab.controller.sessionReady;
    tab.controller.setContentInsets(this.insets);
    tab.controller.setVisible(true);
    this.emitState();
    return this.getState();
  }

  selectTab(id) {
    const tab = this.tabs.get(id);
    if (!tab || this.disposed) return false;
    if (id !== this.activeId) this.active?.setVisible(false);
    this.activeId = id;
    tab.unread = false;
    tab.controller.setVisible(true);
    tab.controller.resize();
    tab.controller.activeContents()?.focus();
    this.emitState();
    return this.getState();
  }

  async ask(kind, tab) {
    if (this.prompting) return false;
    this.prompting = true;
    try { return await this.confirm(kind, tab.controller.getState()); }
    finally { this.prompting = false; }
  }

  async requestNavigation(id, { url, separate = false, generating = false } = {}) {
    const tab = this.tabs.get(id);
    if (!tab || id !== this.activeId || this.disposed || !isChatGptNavigation(url)) return false;
    const key = conversationKey(url);
    const existing = key && [...this.tabs.values()].find(item => tabKey(item) === key);
    if (existing) return this.selectTab(existing.id);
    if (separate) return this.openTab(url);
    if (protectedTab(tab.controller) || generating) {
      if (!await this.ask('open', tab) || this.disposed || !this.tabs.has(id)) return false;
      return this.openTab(url);
    }
    return tab.controller.openUrl(url);
  }

  async closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab || this.disposed) return false;
    if (protectedTab(tab.controller) && !await this.ask('close', tab)) return false;
    if (this.disposed || !this.tabs.has(id)) return false;
    const ids = [...this.tabs.keys()], index = ids.indexOf(id);
    this.tabs.delete(id);
    tab.controller.dispose();
    if (id === this.activeId) {
      this.activeId = '';
      if (this.tabs.size) return this.selectTab(ids[index + 1] || ids[index - 1]);
      return this.openTab();
    }
    this.emitState();
    return this.getState();
  }

  async navigate(action) {
    const tab = this.tabs.get(this.activeId);
    if (!tab) return false;
    if (action === 'home') return this.requestNavigation(tab.id, { url: CHAT_HOME });
    if (protectedTab(tab.controller) && !await this.ask('navigate', tab)) return false;
    if (this.disposed || !this.tabs.has(tab.id)) return false;
    return tab.controller.navigate(action);
  }

  handleShortcut(input) {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return false;
    const key = String(input.key).toLowerCase();
    if (key === 't' && !input.shift) { try { this.openTab(); } catch (error) { this.reportError(error); } return true; }
    if (key === 'w' && !input.shift) { void this.closeTab(this.activeId).catch(error => this.reportError(error)); return true; }
    if (key !== 'tab') return false;
    const ids = [...this.tabs.keys()], index = ids.indexOf(this.activeId);
    this.selectTab(ids[(index + (input.shift ? -1 : 1) + ids.length) % ids.length]);
    return true;
  }

  openUrl(url) {
    if (!isChatGptNavigation(url)) return this.active?.openUrl(url);
    return this.requestNavigation(this.activeId, { url });
  }

  setContentInsets(insets) {
    this.insets = { ...insets };
    for (const tab of this.tabs.values()) tab.controller.setContentInsets(insets);
  }

  applyChatAppearance() { return Promise.all([...this.tabs.values()].map(tab => tab.controller.applyChatAppearance())); }
  async cancelNativeLogin() { await Promise.all([...this.tabs.values()].map(tab => tab.controller.cancelNativeLogin())); return this.getState(); }
  activeContents() { return this.active?.activeContents(); }
  stopGeneration() { return this.active?.stopGeneration(); }
  injectPrompt(...args) { return this.active?.injectPrompt(...args); }
  offerLogin(...args) { return this.active?.offerLogin(...args); }
  dismissLogin() { this.active?.dismissLogin(); return this.getState(); }
  async finishNativeLogin() { await this.active?.finishNativeLogin(); return this.getState(); }
  applyBrowserProxyPolicy(options) { return this.active?.applyBrowserProxyPolicy(options); }
  ensureLoginSafe() {
    if ([...this.tabs.values()].some(tab => tab.id !== this.activeId && protectedTab(tab.controller))) throw new Error('其他标签仍在生成或恢复连接，请结束后再修复共享登录。');
  }
  async startEmbeddedLogin() { this.ensureLoginSafe(); await this.active?.startEmbeddedLogin(); return this.getState(); }
  async startNativeLogin() { this.ensureLoginSafe(); await this.active?.startNativeLogin(); return this.getState(); }
  async clearSession() {
    if (this.hasRunningWork()) throw new Error('仍有标签正在生成或恢复连接，请结束后再清理共享登录。');
    await this.active?.clearSession();
    for (const [id, tab] of this.tabs) if (id !== this.activeId) { this.tabs.delete(id); tab.controller.dispose(); }
    this.emitState();
    return this.getState();
  }

  getState() {
    return { ...this.active?.getState(), activeTabId: this.activeId, maxTabs: MAX_TABS, tabs: [...this.tabs.values()].map(tab => {
      const state = tab.controller.getState();
      return { id: tab.id, title: state.title || '新对话', url: state.url, active: tab.id === this.activeId,
        loading: state.loading, status: state.streamState?.status || 'unknown', unread: tab.unread,
        protected: protectedTab(tab.controller) };
    }) };
  }
  emitState() { if (!this.disposed) this.options.onState?.(this.getState()); }
  reportError(error) {
    this.options.log.warn('对话标签操作未完成', { error: error.message });
    if (!this.disposed) this.options.onState?.({ ...this.getState(), tabError: error.message });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const tab of this.tabs.values()) tab.controller.dispose();
    this.tabs.clear();
  }
}

module.exports = { ChatTabsController, conversationKey, protectedTab };
