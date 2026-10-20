const { shell, session, WebContentsView, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { DownloadService } = require('./services/downloadService');
const { readBoundedDomText } = require('./chatDomText');
const { normalizeProxyValue, resolveProxy } = require('./services/proxyService');
const { NativeLoginService, SESSION_CHECK } = require('./services/nativeLoginService');
const { AUTH_HOSTS, authUrl, readAuthenticatedSession, LOGIN_DOCUMENT_PROBE } = require('./services/chatLoginPolicy');

const CHAT_HOME = 'https://chatgpt.com/';
const CHAT_SCROLLBARS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'scrollbars.css'), 'utf8');
const CHAT_CLAUDE_CSS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat-claude.css'), 'utf8');
const { applyChatAppearanceDocument } = require('../renderer/chat-appearance');
const CHAT_PARTITION = 'persist:chatgpt-session';
const NAVIGATION_HOSTS = new Set([
  'chatgpt.com', 'www.chatgpt.com', 'openai.com', 'www.openai.com',
  ...AUTH_HOSTS
]);
const POPUP_HOSTS = new Set([
  ...AUTH_HOSTS
]);
const TRANSIENT_CHAT_LOAD_ERROR = /ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED|HTTP2_PROTOCOL_ERROR|INCOMPLETE_CHUNKED_ENCODING)/i;
const CHAT_NETWORK_DIAGNOSTIC_SESSIONS = new WeakSet();
async function boundedLoginCheck(promise, timeoutMs = 6000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('登录检查超时')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
const CHAT_RENDER_ERROR_MARKERS = [
  '出错了，无法显示此消息',
  'There was an error displaying this message',
  'Unable to display this message'
];
const CHAT_STREAM_RECOVERY_ERROR_MARKERS = [
  'ChatGPT stream recovery polling timed out'
];
const CHAT_MESSAGE_STREAM_ERROR_MARKERS = [
  '消息流中的错误', '消息流出现错误', 'Error in message stream', 'Error in the message stream'
];
const CHAT_DYNAMIC_ASSET_ERROR = /(?:failed to fetch dynamically imported module|loading chunk .* failed|chunkloaderror|importing a module script failed)/i;

function parseUrl(value) {
  try { return new URL(value); } catch { return null; }
}

function isAllowedNavigation(value) {
  const parsed = parseUrl(value);
  return Boolean(parsed && parsed.protocol === 'https:' && NAVIGATION_HOSTS.has(parsed.hostname.toLowerCase()));
}

function isAuthPopup(value) {
  const parsed = parseUrl(value);
  return Boolean(parsed && parsed.protocol === 'https:' && POPUP_HOSTS.has(parsed.hostname.toLowerCase()));
}

function isChatGptNavigation(value) {
  const parsed = parseUrl(value);
  if (!parsed || parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'chatgpt.com' || host === 'www.chatgpt.com';
}

function isTransientChatLoadError(description) {
  return TRANSIENT_CHAT_LOAD_ERROR.test(String(description || ''));
}

function isChatConversationUrl(value) {
  const parsed = parseUrl(value);
  if (!parsed || !isChatGptNavigation(value)) return false;
  return /(^|\/)c\/[^/]+/i.test(parsed.pathname);
}

function isChatDownloadUrl(value) {
  const url = parseUrl(value);
  if (!url) return false;
  if (url.protocol === 'blob:') return isChatGptNavigation(url.origin);
  if (url.protocol !== 'https:') return false;
  return url.hostname.toLowerCase().endsWith('.oaiusercontent.com')
    || isChatGptNavigation(value) && (/^\/backend-api\/files\/download\//i.test(url.pathname)
      || /^\/backend-api\/(?:files|conversation)\/.+\/download(?:\/|$)/i.test(url.pathname));
}

function isChatMessageRenderErrorText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return CHAT_RENDER_ERROR_MARKERS.some((marker) => text.includes(marker.toLowerCase()));
}

function isChatStreamRecoveryTimeoutText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return CHAT_STREAM_RECOVERY_ERROR_MARKERS.some((marker) => text.includes(marker.toLowerCase()));
}

function chromeLikeUserAgent(value) {
  return String(value || '')
    .replace(/\s(?:Electron|web-mcp-assistant)\/[^\s]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function browserProxyConfig(settings = {}) {
  const mode = ['auto', 'system', 'manual', 'direct'].includes(settings.proxyMode) ? settings.proxyMode : 'auto';
  if (mode === 'direct') return { mode: 'direct' };
  if (mode === 'manual') {
    const proxyRules = normalizeProxyValue(settings.proxyUrl);
    return proxyRules
      ? { mode: 'fixed_servers', proxyRules, proxyBypassRules: '<local>' }
      : { mode: 'direct' };
  }
  return { mode: 'system' };
}

function proxyRouteKey(value) {
  const text = String(value || '').trim();
  if (!text || /^DIRECT$/i.test(text)) return 'direct';
  if (/^https?:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      return `${parsed.hostname.toLowerCase()}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
    } catch { return text.toLowerCase(); }
  }
  const match = text.match(/(?:PROXY|HTTPS?|SOCKS5?)\s+([^;]+)/i);
  return match ? match[1].toLowerCase() : text.toLowerCase();
}

function bindChatNetworkDiagnostics(chatSession, log) {
  if (!chatSession || CHAT_NETWORK_DIAGNOSTIC_SESSIONS.has(chatSession)) return;
  CHAT_NETWORK_DIAGNOSTIC_SESSIONS.add(chatSession);
  const filter = { urls: ['https://chatgpt.com/*', 'https://*.chatgpt.com/*', 'https://*.openai.com/*', 'https://*.oaistatic.com/*', 'https://*.oaiusercontent.com/*'] };
  const recent = new Map();
  const report = (details) => {
    const parsed = parseUrl(details.url);
    if (details.error === 'net::ERR_ABORTED') return;
    // Route category only: no query strings, OAuth codes or conversation IDs.
    const parts = (parsed?.pathname || '').split('/').filter(Boolean);
    const route = ['backend-api', 'api'].includes(parts[0]) ? `/${parts.slice(0, 2).join('/')}` : '/';
    const key = `${parsed?.hostname}|${route}|${details.resourceType}|${details.error || details.statusCode}`;
    const now = Date.now();
    if (now - (recent.get(key) || 0) < 30000) return;
    recent.set(key, now);
    if (recent.size > 100) for (const [item, time] of recent) if (now - time > 30000) recent.delete(item);
    log.warn('ChatGPT 浏览器网络请求失败', {
      host: parsed?.hostname || '',
      route,
      resourceType: String(details.resourceType || ''),
      error: String(details.error || ''),
      statusCode: Number(details.statusCode || 0),
      fromCache: Boolean(details.fromCache)
    });
  };
  chatSession.webRequest.onErrorOccurred(filter, report);
  chatSession.webRequest.onCompleted(filter, (details) => { if (details.statusCode >= 400) report(details); });
}

class ChatViewController {
  constructor({ window, log, settings, nativeLoginRoot, createWebContentsView = (options) => new WebContentsView(options), toolbarHeight = 64, onState = () => {}, onDownload = () => {}, onConversationTurn = () => {}, onNativeFocus = () => {} }) {
    this.window = window;
    this.log = log;
    this.toolbarHeight = toolbarHeight;
    this.onState = onState;
    this.onNativeFocus = onNativeFocus;
    this.settings = settings;
    this.nativeLoginRoot = nativeLoginRoot;
    this.nativeLogin = null;
    this.createWebContentsView = createWebContentsView;
    this.authViews = [];
    this.downloadViews = [];
    this.login = { status: 'idle', mode: '', prompt: false, kind: '', message: '', returning: false };
    this.loginRevision = 0;
    this.loginPromptSeen = new Set();
    this.onDownload = onDownload;
    this.onConversationTurn = onConversationTurn;
    this.view = null;
    this.disposed = false;
    this.contentBindings = [];
    this.loadTimer = null;
    this.enhancementTimer = null;
    this.loading = false;
    this.lastError = '';
    this.errorLayer = '';
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.nextRetryAt = 0;
    this.bottomInset = 0;
    this.topOverlay = 0;
    this.mcpAttachment = { status: 'unknown', event: 'init', detail: '', updatedAt: 0 };
    this.browserNetwork = { mode: '', browserRoute: '', tunnelRoute: '', aligned: null, source: '', updatedAt: 0 };
    this.streamState = { status: 'unknown', event: 'init', updatedAt: 0, activityAt: 0, quietSeconds: 0, stalled: false };
    this.streamDocumentRevision = 0;
    this.pendingPageLoadReason = '';
    this.chatAppearance = { enabled:false, active:false, message:'使用原生 ChatGPT 外观' };
    this.chatAppearanceCss = null;
    this.chatAppearancePending = Promise.resolve();
    this.chatAppearanceDocument = 0;
    this.chatAppearanceAbort = new AbortController();
    this.boundResize = () => this.resize();
  }

  applyChatAppearance() {
    if (this.disposed) return Promise.resolve({ ...this.chatAppearance,active:false });
    const apply = async () => {
      const current = this.settings?.load?.() || {};
      const enabled = current.experimentalClaudeChat === true;
      const contents = this.view?.webContents;
      const url = contents && !contents.isDestroyed() ? contents.getURL() : '';
      const eligible = !this.disposed && isChatGptNavigation(url) && !authUrl(url);
      const theme = current.theme === 'system' ? (nativeTheme?.shouldUseDarkColors ? 'dark' : 'light') : current.theme;
      const documentRevision = this.chatAppearanceDocument;
      const touchDocument = enabled || this.chatAppearance.enabled || Boolean(this.chatAppearanceCss);
      try {
        if ((!enabled || !eligible) && this.chatAppearanceCss) {
          const { owner, key } = this.chatAppearanceCss;
          this.chatAppearanceCss = null;
          if (!owner.isDestroyed()) await owner.removeInsertedCSS(key).catch(() => {});
        }
        let active = false;
        if (eligible && touchDocument) {
          if (enabled && !this.chatAppearanceCss) {
            const key = await contents.insertCSS(CHAT_CLAUDE_CSS,{cssOrigin:'user'});
            if (documentRevision !== this.chatAppearanceDocument || this.disposed) {
              if (!contents.isDestroyed()) await contents.removeInsertedCSS(key).catch(() => {});
              return { ...this.chatAppearance };
            }
            this.chatAppearanceCss = { owner:contents,key };
          }
          const result = await contents.executeJavaScript(`(${applyChatAppearanceDocument.toString()})(${JSON.stringify({enabled,theme,url})})`);
          if (documentRevision !== this.chatAppearanceDocument || this.disposed) return { ...this.chatAppearance };
          active = Boolean(enabled && result?.active);
        }
        if ((this.settings?.load?.().experimentalClaudeChat === true) !== enabled) return { ...this.chatAppearance };
        this.chatAppearance = { enabled,active,pending:false,message:!enabled?'使用原生 ChatGPT 外观':active?'Claude 对话外观已应用；使用原网页数据':'实验外观已开启；网页就绪后应用，不匹配时显示原生布局' };
      } catch {
        if (this.chatAppearanceCss) {
          const { owner,key } = this.chatAppearanceCss;
          this.chatAppearanceCss = null;
          if (!owner.isDestroyed()) await owner.removeInsertedCSS(key).catch(() => {});
        }
        this.chatAppearance = { enabled,active:false,message:'实验外观未能应用，当前使用原生布局；可以关闭开关' };
      }
      if (!this.disposed) this.emitState();
      return { ...this.chatAppearance };
    };
    this.chatAppearancePending = this.chatAppearancePending.then(apply,apply);
    let timer,abort;
    const stopped = new Promise(resolve => {
      abort = () => resolve({ ...this.chatAppearance,active:false,pending:false });
      this.chatAppearanceAbort.signal.addEventListener('abort',abort,{once:true});
    });
    const waiting = new Promise(resolve => { timer = setTimeout(() => {
      this.chatAppearance = { ...this.chatAppearance,enabled:this.settings?.load?.().experimentalClaudeChat===true,pending:true,message:'等待当前网页响应；已保留开关选择，不会重新发送消息' };
      if (!this.disposed) this.emitState();
      resolve({ ...this.chatAppearance });
    },2500); });
    return Promise.race([this.chatAppearancePending,stopped,waiting]).finally(() => {
      clearTimeout(timer);
      this.chatAppearanceAbort.signal.removeEventListener('abort',abort);
    });
  }

  setContentInsets({ top = 0, bottom = 0, left = 0, right = 0, toolbarHeight = this.toolbarHeight } = {}) {
    const nextTop = Math.max(0, Number(top) || 0);
    const nextBottom = Math.max(0, Number(bottom) || 0);
    const nextRight = Math.max(0, Math.min(600, Number(right) || 0));
    const nextLeft = Math.max(0, Math.min(420, Number(left) || 0));
    const nextToolbar = Math.max(0, Math.min(240, Number(toolbarHeight) || 0));
    if (this.topOverlay === nextTop && this.bottomInset === nextBottom && (this.leftInset || 0) === nextLeft && (this.rightInset || 0) === nextRight && this.toolbarHeight === nextToolbar) return;
    this.topOverlay = nextTop;
    this.bottomInset = nextBottom;
    this.rightInset = nextRight;
    this.leftInset = nextLeft;
    this.toolbarHeight = nextToolbar;
    this.resize();
  }

  updateStreamState(payload = {}) {
    const next = {
      status: String(payload.status || this.streamState.status || 'unknown'),
      event: String(payload.event || 'page-stream'),
      updatedAt: Date.now(),
      activityAt: Number(payload.activityAt ?? payload.activity_at ?? this.streamState.activityAt ?? 0),
      quietSeconds: Math.max(0, Number(payload.quietSeconds ?? payload.quiet_seconds ?? this.streamState.quietSeconds ?? 0)),
      stalled: Boolean(payload.stalled ?? this.streamState.stalled),
      pageQuiet: Boolean(payload.pageQuiet ?? payload.page_quiet ?? this.streamState.pageQuiet ?? false),
      documentId: this.streamDocumentRevision,
      webContentsId: this.view?.webContents?.id || 0,
      conversationId: this.streamConversationId(),
      detail: String(payload.detail ?? this.streamState.detail ?? '')
    };
    const changed = next.status !== this.streamState.status || next.event !== this.streamState.event
      || next.stalled !== this.streamState.stalled
      || Math.floor(next.quietSeconds / 5) !== Math.floor(Number(this.streamState.quietSeconds || 0) / 5);
    this.streamState = next;
    if (changed) {
      this.log[next.status === 'interrupted' ? 'warn' : 'info']('ChatGPT 回答流状态变化', next);
      this.emitState();
    }
  }

  streamConversationId() {
    return parseUrl(this.view?.webContents?.getURL() || '')?.pathname.match(/(?:^|\/)c\/([^/]+)/)?.[1] || '';
  }

  resetStreamDocument() {
    this.streamDocumentRevision++;
    this.updateStreamState({ status: 'unknown', event: 'page-navigation', activityAt: 0, quietSeconds: 0, stalled: false, pageQuiet: false, detail: '' });
  }

  async refreshBrowserNetworkDiagnostics({ force = false } = {}) {
    const chatSession = session.fromPartition(CHAT_PARTITION);
    const current = this.settings.load();
    const [browserRoute, tunnelProxy] = await Promise.all([
      chatSession.resolveProxy(CHAT_HOME).catch(() => ''),
      resolveProxy(current, { force }).catch(() => ({ resolvedUrl: '', source: 'error', reachable: false }))
    ]);
    const tunnelRoute = String(tunnelProxy.resolvedUrl || 'DIRECT');
    const browserRouteText = String(browserRoute || 'DIRECT');
    const aligned = proxyRouteKey(browserRouteText) === proxyRouteKey(tunnelRoute);
    this.browserNetwork = {
      mode: String(current.proxyMode || 'auto'),
      browserRoute: browserRouteText.slice(0, 240),
      tunnelRoute: tunnelRoute.slice(0, 240),
      aligned,
      source: String(tunnelProxy.source || ''),
      updatedAt: Date.now()
    };
    this.log[aligned ? 'info' : 'warn']('ChatGPT 页面与 Tunnel 网络路径检查', this.browserNetwork);
    this.emitState();
    return { ...this.browserNetwork };
  }

  async applyBrowserProxyPolicy({ closeConnections = false, forceProbe = false } = {}) {
    const chatSession = session.fromPartition(CHAT_PARTITION);
    const current = this.settings.load();
    const config = browserProxyConfig(current);
    await chatSession.setProxy(config);
    if (closeConnections && typeof chatSession.closeAllConnections === 'function') await chatSession.closeAllConnections();
    this.refreshBrowserNetworkDiagnostics({ force: forceProbe }).catch(() => {});
    return config;
  }

  updateMcpAttachmentState(payload = {}) {
    const next = {
      status: String(payload.status || this.mcpAttachment.status || 'unknown'),
      event: String(payload.event || 'page-log'),
      detail: String(payload.detail || ''),
      updatedAt: Date.now()
    };
    const changed = next.status !== this.mcpAttachment.status
      || next.event !== this.mcpAttachment.event
      || next.detail !== this.mcpAttachment.detail;
    this.mcpAttachment = next;
    if (changed) this.emitState();
  }

  clearRetryState({ resetAttempt = true } = {}) {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = 0;
    if (resetAttempt) this.retryAttempt = 0;
  }

  scheduleTransientRetry(url, description) {
    // OAuth callbacks can contain one-use codes; never replay or log their URL.
    if (this.disposed || authUrl(url)) return false;
    if (!isTransientChatLoadError(description) || !isAllowedNavigation(url) || this.retryTimer) return false;
    if (isChatConversationUrl(url)) {
      this.log.warn('当前 ChatGPT 对话发生瞬时网络错误，保留对话上下文并交由页面自身恢复，不自动重载', {
        url,
        description
      });
      return false;
    }
    if (this.retryAttempt >= 5) {
      this.lastError = 'ChatGPT 连接多次失败，请检查代理网络后点击刷新';
      return false;
    }
    const delay = Math.min(30000, 1500 * (2 ** Math.min(this.retryAttempt, 5)));
    this.retryAttempt += 1;
    this.nextRetryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = 0;
      const contents = this.view?.webContents;
      if (this.disposed || !contents || contents.isDestroyed()) return;
      const currentUrl = contents.getURL();
      if (isChatConversationUrl(currentUrl) || authUrl(currentUrl) || (isAllowedNavigation(currentUrl) && currentUrl !== url)) return;
      this.pendingPageLoadReason = 'transient-retry-non-conversation';
      contents.loadURL(url).catch((error) => {
        this.lastError = error.message;
        this.errorLayer = 'chat-page';
        this.emitState();
      });
    }, delay);
    this.retryTimer.unref?.();
    this.log.warn('ChatGPT 页面网络加载中断，将按退避策略重试页面；不会重启本地 MCP', {
      url, description, attempt: this.retryAttempt, delayMs: delay
    });
    return true;
  }

  mount() {
    if (this.disposed || this.view || !this.window || this.window.isDestroyed()) return;
    const chatSession = session.fromPartition(CHAT_PARTITION);
    // Keep Electron's actual browser identity consistent across requests, client hints and OAuth children.
    // The reference launcher also uses its native identity, not a separately rewritten Chrome UA.
    const browserUserAgent = chatSession.getUserAgent();
    bindChatNetworkDiagnostics(chatSession, this.log);
    const browserNetworkReady = this.applyBrowserProxyPolicy().catch((error) => {
      this.log.warn('ChatGPT 浏览器代理策略应用失败，将继续使用 Chromium 当前网络配置', { error: String(error?.message || error) });
    });
    new DownloadService({ electronSession: chatSession, settings: this.settings, log: this.log, onState: this.onDownload }).bind();
    const mayWriteClipboard = (permission, origin) => permission === 'clipboard-sanitized-write' && isAllowedNavigation(origin);
    chatSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      callback(mayWriteClipboard(permission, details.requestingUrl || details.securityOrigin || ''));
    });
    chatSession.setPermissionCheckHandler((_webContents, permission, origin) => mayWriteClipboard(permission, origin));

    this.view = this.createWebContentsView({
      webPreferences: {
        partition: CHAT_PARTITION,
        backgroundThrottling: false,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    });
    this.view.webContents.setBackgroundThrottling(false);
    this.view.webContents.on('focus', this.onNativeFocus);
    if (browserUserAgent) this.view.webContents.setUserAgent(browserUserAgent);
    this.view.setBackgroundColor('#f7f7f8');
    this.window.contentView.addChildView(this.view);
    this.window.on('resize', this.boundResize);
    this.resize();
    this.bindWebContents();
    browserNetworkReady.then(() => { if (!this.disposed) return this.loadHome(); }).catch(() => {});
  }

  bindWebContents() {
    const contents = this.view.webContents;
    const listen = (name, callback) => {
      const guarded = (...args) => { if (!this.disposed && !contents.isDestroyed()) callback(...args); };
      contents.on(name, guarded);
      this.contentBindings.push({ contents, name, guarded });
    };
    contents.setWindowOpenHandler(({ url }) => {
      if (isChatDownloadUrl(url)) {
        this.startDownload(contents, url);
        return { action: 'deny' };
      }
      if (authUrl(url) || url === 'about:blank' && authUrl(contents.getURL())) {
        if (this.authViews.length >= 4) { this.offerLogin('blocked', contents, true); return { action: 'deny' }; }
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: {
              partition: CHAT_PARTITION,
              backgroundThrottling: false,
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              webSecurity: true
            }
          },
          createWindow: (options) => this.createEmbeddedAuthView(options, url).webContents
        };
      }
      if (url === 'about:blank' && isChatGptNavigation(contents.getURL())) {
        if (this.downloadViews.length >= 4) return { action: 'deny' };
        return { action: 'allow', overrideBrowserWindowOptions: {
          webPreferences: { partition: CHAT_PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
        }, createWindow: (options) => this.createDownloadView(options).webContents };
      }
      if (isAllowedNavigation(url) && parseUrl(url)?.hostname.toLowerCase().endsWith('chatgpt.com')) {
        this.openUrl(url);
      } else if (/^https?:/i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });
    listen('will-navigate', (event, url) => {
      if (isAllowedNavigation(url)) return;
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    });
    listen('did-start-loading', () => {
      if (this.disposed) return;
      this.resetStreamDocument();
      const reason = this.pendingPageLoadReason || 'page-or-browser-navigation';
      this.pendingPageLoadReason = '';
      this.log.info('ChatGPT 页面开始加载', { host: parseUrl(contents.getURL())?.hostname || '', reason });
      this.loading = true;
      this.lastError = '';
      this.errorLayer = '';
      this.armLoadDeadline(contents);
      this.emitState();
    });
    listen('did-finish-load', async () => {
      clearTimeout(this.loadTimer);
      this.loadTimer = null;
      this.clearRetryState();
      const previousError = this.lastError;
      if (!await this.verifyLoadedDocument(contents) || this.lastError !== previousError) return;
      this.lastError = '';
      this.errorLayer = '';
      if (this.streamState.status === 'render_error') this.updateStreamState({ status: 'healthy', event: 'page-message-render-recovered' });
      this.emitState();
    });
    listen('dom-ready', () => {
      this.chatAppearanceDocument++;
      this.chatAppearanceCss = null; // Navigation discards styles inserted into the old document.
      if (isChatGptNavigation(contents.getURL()) && !authUrl(contents.getURL())) {
        void contents.insertCSS(CHAT_SCROLLBARS, { cssOrigin: 'user' }).catch((error) => this.log.warn('网页滚动条样式未载入', { message: error.message }));
      }
      this.scheduleChatUiEnhancements();
      if (authUrl(contents.getURL()) || parseUrl(contents.getURL())?.pathname === '/') this.startLoginWatch();
      void this.probeLogin(contents);
    });
    listen('did-stop-loading', () => {
      clearTimeout(this.loadTimer);
      this.loadTimer = null;
      this.loading = false;
      this.emitState();
      this.scheduleChatUiEnhancements();
      void this.probeLogin(contents);
    });
    listen('did-navigate', () => {
      this.emitState();
    });
    listen('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      this.resetStreamDocument();
      this.emitState();
      this.suspendChatUiEnhancements();
      clearTimeout(this.enhancementTimer);
      this.enhancementTimer = setTimeout(() => this.scheduleChatUiEnhancements(), 1200);
    });
    listen('console-message', (_event, level, message) => {
      const memoryPrefix = '[web-mcp-memory] ';
      const raw = String(_event?.message ?? (level && typeof level === 'object' ? level.message : message) ?? '');
      if (raw.startsWith(memoryPrefix)) {
        contents.executeJavaScript(`(() => { const payload = window.__mcpAutoMemoryQueue || null; window.__mcpAutoMemoryQueue = null; return payload; })()`, true).then((payload) => {
          if (!payload || typeof payload !== 'object') return;
          return this.onConversationTurn({ userText: String(payload.user_text || '').slice(0,6000), assistantText: String(payload.assistant_text || '').slice(0,8000), conversationId: String(payload.conversation_id || '').slice(0,160), turnId: String(payload.turn_id || '').slice(0,160) });
        }).catch(() => {});
        return;
      }
      const streamPrefix = '[web-mcp-stream] ';
      if (raw.startsWith(streamPrefix)) {
        if (_event?.frame && contents.mainFrame && _event.frame !== contents.mainFrame) return;
        let payload = {};
        try { payload = JSON.parse(raw.slice(streamPrefix.length)); } catch { payload = { event: 'page-stream' }; }
        if (payload.document_id !== this.streamDocumentRevision || payload.conversation_id !== this.streamConversationId()) return;
        this.updateStreamState({
          event: payload.event,
          status: payload.status,
          activityAt: payload.activity_at,
          quietSeconds: payload.quiet_seconds,
          stalled: payload.stalled,
          pageQuiet: payload.page_quiet,
          detail: payload.detail
        });
        return;
      }
      if (CHAT_DYNAMIC_ASSET_ERROR.test(raw)) {
        this.lastError = 'ChatGPT 页面资源加载失败，请刷新页面重试';
        this.errorLayer = 'chat-page';
        this.updateStreamState({ status: 'asset_error', event: 'page-asset-error', detail: raw.slice(0, 240) });
        this.log.warn('ChatGPT 页面动态资源加载失败', { detail: raw.slice(0, 500) });
        this.emitState();
        return;
      }
      const prefix = '[web-mcp-continuous] ';
      if (!raw.startsWith(prefix)) return;
      let payload = {};
      try { payload = JSON.parse(raw.slice(prefix.length)); } catch { payload = { event: 'page-log' }; }
      const meta = {
        event: String(payload.event || 'unknown'),
        detail: String(payload.detail || ''),
        status: String(payload.status || '')
      };
      this.updateMcpAttachmentState(meta);
      if (Number(level) >= 2 || meta.event === 'attach-failed') this.log.warn('连续 MCP 页面事件', meta);
      else this.log.info('连续 MCP 页面事件', meta);
    });
    listen('page-title-updated', () => this.emitState());
    listen('unresponsive', () => {
      this.lastError = 'ChatGPT 页面暂时无响应';
      this.errorLayer = 'chat-renderer';
      this.log.warn(this.lastError, { host: parseUrl(contents.getURL())?.hostname || '' });
      this.emitState();
    });
    listen('responsive', async () => {
      this.log.info('ChatGPT 页面进程已恢复响应');
      if (!await this.verifyLoadedDocument(contents)) return;
      if (this.errorLayer === 'chat-renderer' && this.lastError === 'ChatGPT 页面暂时无响应') {
        this.lastError = '';
        this.errorLayer = '';
      }
      this.emitState();
    });
    listen('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      clearTimeout(this.loadTimer);
      this.loadTimer = null;
      this.loading = false;
      this.lastError = `${errorDescription} (${errorCode})`;
      this.errorLayer = 'chat-page';
      this.log.warn('ChatGPT 页面加载失败', { host: parseUrl(validatedURL)?.hostname || '', errorCode, errorDescription });
      this.scheduleTransientRetry(validatedURL, errorDescription);
      this.emitState();
    });
    listen('render-process-gone', (_event, details) => {
      if (this.disposed) return;
      clearTimeout(this.loadTimer);
      this.loadTimer = null;
      this.loading = false;
      this.lastError = `页面进程已退出：${details.reason}`;
      this.errorLayer = 'chat-renderer';
      this.log.error(this.lastError, { exitCode: details.exitCode });
      this.emitState();
    });
  }

  startDownload(contents, url) {
    if (this.disposed || contents.isDestroyed()) return;
    try { contents.downloadURL(url); }
    catch (error) {
      this.log.warn('ChatGPT 附件下载未能启动', { error: error.message });
      this.onDownload({ status: 'interrupted', error: '附件下载未能启动，请重试。' });
    }
  }

  createDownloadView(options = {}) {
    // Retain Chromium's opener for pages that open a blank window before assigning a file URL.
    const view = this.createWebContentsView({ webContents: options.webContents });
    const contents = view.webContents;
    const downloadSession = contents.session;
    this.downloadViews.push(view);
    const close = () => setImmediate(() => { if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false }); });
    const deadline = setTimeout(close, 60000);
    deadline.unref?.();
    const onDownload = (_event, item, source) => {
      if (source === contents) { clearTimeout(deadline); item.once('done', close); }
    };
    downloadSession.on('will-download', onDownload);
    contents.once('destroyed', () => {
      clearTimeout(deadline);
      downloadSession.removeListener('will-download', onDownload);
      this.downloadViews = this.downloadViews.filter((item) => item !== view);
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (url === 'about:blank') return;
      event.preventDefault();
      if (isChatDownloadUrl(url)) this.startDownload(contents, url);
      else { if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {}); close(); }
    });
    return view;
  }

  armLoadDeadline(contents, timeoutMs = 60000) {
    clearTimeout(this.loadTimer);
    this.loadTimer = setTimeout(() => {
      this.loadTimer = null;
      if (this.disposed || contents.isDestroyed() || !contents.isLoadingMainFrame()) return;
      const url = contents.getURL();
      const conversation = isChatConversationUrl(url);
      if (!conversation) contents.stop();
      this.loading = conversation;
      this.lastError = conversation ? 'ChatGPT 页面加载超过 60 秒，仍在等待网页恢复；可以重新加载原会话'
        : 'ChatGPT 页面加载超过 60 秒，请检查代理网络后点击刷新';
      this.errorLayer = 'chat-page';
      this.log.warn('ChatGPT 页面加载超时', { host: parseUrl(url)?.hostname || '' });
      this.scheduleTransientRetry(url, 'ERR_TIMED_OUT');
      this.emitState();
    }, timeoutMs);
    this.loadTimer.unref?.();
  }

  async verifyLoadedDocument(contents) {
    if (!isChatGptNavigation(contents.getURL()) || authUrl(contents.getURL())) return true;
    const revision = this.streamDocumentRevision;
    try {
      const document = await boundedLoginCheck(contents.executeJavaScript(`({ readyState: document.readyState, hasRoot: Boolean(document.documentElement) })`));
      if (this.disposed || contents.isDestroyed() || contents !== this.view?.webContents || revision !== this.streamDocumentRevision) return false;
      if (document?.hasRoot === true) return true;
      if (document?.readyState === 'complete' && document.hasRoot === false) {
        const message = 'ChatGPT 页面内容为空，请重新加载原会话';
        if (this.lastError !== message) this.log.warn(message, { host: parseUrl(contents.getURL())?.hostname || '' });
        this.lastError = message;
        this.errorLayer = 'chat-page';
        this.loading = false;
        this.emitState();
      }
    } catch {}
    return false;
  }

  activeContents() {
    const authViews = this.liveAuthViews();
    return !this.login.returning && authViews.at(-1)?.webContents || this.view?.webContents;
  }

  liveAuthViews() {
    const live = this.authViews.filter((view) => view?.webContents && !view.webContents.isDestroyed());
    if (live.length !== this.authViews.length) this.authViews = live;
    return live;
  }

  setLogin(patch) {
    this.login = { ...this.login, ...patch };
    this.syncLoginVisibility();
    this.emitState();
  }

  syncLoginVisibility() {
    if (this.disposed) return;
    const authViews = this.liveAuthViews();
    // Embedded auth views are native child views layered above the primary ChatGPT view.
    // Keep ChatGPT visible underneath them so a transient/blank/destroyed OAuth child can
    // never expose the shell's startup placeholder. Only the shell DOM login prompt needs
    // the primary native view hidden so that the dialog can render above it.
    if (this.view && !this.view.webContents.isDestroyed()) this.view.setVisible(!this.login.prompt);
    for (const view of authViews) view.setVisible(!this.login.prompt && !this.login.returning && view === authViews.at(-1));
  }

  offerLogin(kind = 'entry', contents = this.activeContents(), force = false) {
    if (this.nativeLogin?.run || !contents || contents.isDestroyed()) return;
    if (!force && this.login.mode === 'embedded' && kind === 'entry') return;
    const url = parseUrl(contents.getURL());
    const key = `${url?.hostname || ''}${url?.pathname || ''}:${kind}`;
    if (!force && this.loginPromptSeen.has(key)) return;
    const embeddedAuthView = this.authViews.some((view) => view.webContents === contents);
    // Passive probes on the primary ChatGPT view must never hide the chat behind
    // the shell's modal login dialog. The live ChatGPT page can render its own
    // sign-in state; only an explicit user action or an actual embedded auth view
    // failure may take over the shell UI.
    if (!force && !embeddedAuthView) {
      this.loginPromptSeen.add(key);
      return;
    }
    this.loginPromptSeen.add(key);
    this.setLogin({ status: 'prompt', prompt: true, kind, returning: false,
      message: kind === 'blocked' ? 'Google 拒绝了当前登录环境。可以在应用内重新发起登录，也可以选择浏览器备用登录，成功后会自动返回。'
        : kind === 'load-error' ? '登录页面加载失败或超过 60 秒未完成。请重新尝试应用内登录，或选择浏览器备用登录。'
        : '可以直接在助手内完成登录，登录成功后自动回到聊天。' });
  }

  async startEmbeddedLogin() {
    if (this.nativeLogin?.run) throw new Error('请先取消浏览器备用登录。');
    this.loginRevision++;
    this.closeAuthViews();
    this.setLogin({ status: 'waiting', mode: 'embedded', prompt: false, kind: '', returning: false,
      message: '请在应用内完成登录；成功后将自动返回聊天，不需要点击返回按钮。' });
    const view = this.createEmbeddedAuthView({}, 'https://chatgpt.com/auth/login');
    void view.webContents.loadURL('https://chatgpt.com/auth/login').catch(() => {
      if (this.authViews.includes(view)) this.offerLogin('load-error', view.webContents, true);
    });
    return this.getState();
  }

  createEmbeddedAuthView(options = {}, url = '') {
    // Adopt Chromium's supplied child, retaining opener, POST data and OAuth session continuity.
    const view = this.createWebContentsView(options.webContents ? { webContents: options.webContents } : {
      webPreferences: { partition: CHAT_PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false }
    });
    this.authViews.push(view);
    this.window.contentView.addChildView(view);
    this.setLogin({ mode: 'embedded', status: 'waiting', prompt: false, returning: false, message: '正在应用内登录，完成后会自动返回聊天。' });
    this.resize();
    const contents = view.webContents;
    let navigationDeadline;
    contents.on('focus', this.onNativeFocus);
    const clearDeadline = () => { clearTimeout(navigationDeadline); navigationDeadline = null; };
    contents.setBackgroundThrottling(false);
    contents.setWindowOpenHandler(({ url: next }) => {
      if (authUrl(next) || isChatGptNavigation(next) || next === 'about:blank') {
        if (this.authViews.length >= 4) { this.offerLogin('blocked', contents, true); return { action: 'deny' }; }
        return { action: 'allow', overrideBrowserWindowOptions: {
          webPreferences: { partition: CHAT_PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
        }, createWindow: (child) => this.createEmbeddedAuthView(child, next).webContents };
      }
      return { action: 'deny' };
    });
    const restrict = (event, next) => { if (!isAllowedNavigation(next) && next !== 'about:blank') event.preventDefault(); };
    contents.on('will-navigate', restrict);
    contents.on('will-redirect', restrict);
    contents.on('did-start-loading', () => {
      clearDeadline();
      navigationDeadline = setTimeout(() => {
        if (this.authViews.includes(view) && !contents.isDestroyed()) {
          contents.stop(); this.loading = false; this.offerLogin('load-error', contents, true);
        }
      }, 60000);
      navigationDeadline.unref?.();
      if (this.activeContents() === contents) { this.loading = true; this.emitState(); }
    });
    const loaded = () => {
      if (this.activeContents() === contents) { this.loading = false; this.emitState(); void this.probeLogin(contents); }
    };
    contents.on('dom-ready', loaded);
    contents.on('did-stop-loading', () => { clearDeadline(); loaded(); });
    contents.on('did-navigate-in-page', loaded);
    contents.on('did-fail-load', (_event, code, _description, _url, main) => {
      if (main && code !== -3 && this.authViews.includes(view)) { clearDeadline(); this.loading = false; this.offerLogin('load-error', contents, true); }
    });
    const unavailable = () => {
      if (this.authViews.includes(view) && !contents.isDestroyed()) {
        clearDeadline(); this.loading = false; this.offerLogin('load-error', contents, true);
      }
    };
    contents.on('unresponsive', unavailable);
    contents.on('render-process-gone', unavailable);
    contents.once('destroyed', () => {
      clearDeadline();
      const index = this.authViews.indexOf(view);
      if (index !== -1) { this.authViews.splice(index, 1); try { this.window.contentView.removeChildView(view); } catch {} this.syncLoginVisibility(); }
    });
    this.startLoginWatch();
    contents.focus();
    return view;
  }

  startLoginWatch() {
    if (this.disposed || this.loginWatch) return;
    this.loginWatch = setInterval(() => { void this.probeLogin(); }, 1800);
    this.loginWatch.unref?.();
  }

  async probeLogin(contents = this.activeContents()) {
    if (this.disposed || !contents || contents.isDestroyed() || this.loginProbe || this.login.prompt || this.nativeLogin?.run) return;
    if (!isAllowedNavigation(contents.getURL())) return;
    const revision = this.loginRevision;
    const probe = (async () => {
      try {
        const ui = await boundedLoginCheck(contents.executeJavaScript(LOGIN_DOCUMENT_PROBE));
        if (revision !== this.loginRevision || contents !== this.activeContents()) return;
        if (ui?.kind) this.offerLogin(ui.kind, contents);
        if (ui?.composer && !this.login.mode && !ui.kind) { clearInterval(this.loginWatch); this.loginWatch = null; }
        if (ui?.composer && !this.login.prompt && (this.login.mode === 'embedded' || authUrl(contents.getURL()))) {
          if (!await readAuthenticatedSession(contents.session.fetch.bind(contents.session)) || revision !== this.loginRevision) return;
          if (this.authViews.length && !this.login.returning) {
            this.setLogin({ status: 'verifying', returning: true, message: '登录已确认，正在返回助手…' });
            const main = this.view.webContents;
            let deadline;
            try { await Promise.race([main.loadURL(CHAT_HOME), new Promise((_, reject) => { deadline = setTimeout(() => { if (!main.isDestroyed()) main.stop(); reject(new Error('加载超时')); }, 18000); })]); }
            finally { clearTimeout(deadline); }
            if (revision !== this.loginRevision) return;
            const primary = await boundedLoginCheck(main.executeJavaScript(LOGIN_DOCUMENT_PROBE));
            if (!primary?.composer || !await readAuthenticatedSession(main.session.fetch.bind(main.session))) return;
          }
          if (revision !== this.loginRevision) return;
          this.closeAuthViews();
          clearInterval(this.loginWatch); this.loginWatch = null;
          this.setLogin({ status: 'success', mode: '', prompt: false, kind: '', returning: false, message: '已登录，已自动返回 ChatGPT。' });
          this.view.webContents.focus();
        }
      } catch {
        if (revision === this.loginRevision && this.login.mode === 'embedded' && this.login.returning) {
          this.setLogin({ status: 'error', message: '登录返回页面暂未完成，正在重新检查。可以使用醒目的登录入口重试。' });
        }
      }
    })();
    this.loginProbe = probe;
    try { await probe; } finally { if (this.loginProbe === probe) this.loginProbe = null; }
  }

  closeAuthViews() {
    const views = this.authViews.splice(0);
    for (const view of views.reverse()) {
      try { this.window.contentView.removeChildView(view); } catch {}
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    }
    this.syncLoginVisibility();
  }

  dismissLogin() {
    this.loginRevision++;
    this.loginProbe = null;
    clearInterval(this.loginWatch); this.loginWatch = null;
    if (this.login.returning) this.view?.webContents.stop();
    this.closeAuthViews();
    this.setLogin({ status: 'idle', mode: '', prompt: false, kind: '', returning: false, message: '' });
    return this.getState();
  }

  suspendChatUiEnhancements() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.executeJavaScript(`(() => {
      if (window.__mcpAutoMemoryObserver) { try { window.__mcpAutoMemoryObserver.disconnect(); } catch {} window.__mcpAutoMemoryObserver = null; }
      if (window.__mcpAutoMemoryTimer) { clearTimeout(window.__mcpAutoMemoryTimer); window.__mcpAutoMemoryTimer = 0; }
      if (window.__mcpStreamObserver) { try { window.__mcpStreamObserver.disconnect(); } catch {} window.__mcpStreamObserver = null; }
      if (window.__mcpStreamTimer) { clearTimeout(window.__mcpStreamTimer); window.__mcpStreamTimer = 0; }
      if (window.__webMcpContinuousHandlers) { window.__webMcpContinuousHandlers.observer?.disconnect(); clearTimeout(window.__webMcpContinuousHandlers.timer); window.__webMcpContinuousHandlers = null; }
      window.__mcpRenderErrorSince = 0;
      window.__mcpRenderErrorSafe = false;
      return true;
    })()`, true).catch(() => false);
  }

  scheduleChatUiEnhancements() {
    const contents = this.view?.webContents;
    if (this.disposed || !contents || contents.isDestroyed()) return;
    void this.applyChatAppearance();
    this.scheduleMemoryObserver();
    this.scheduleStreamObserver();
    this.scheduleContinuousMcpMode();
  }

  scheduleMemoryObserver() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.executeJavaScript(`(() => {
      const PREFIX='[web-mcp-memory] ', SEEN_KEY='__webMcpAutoMemorySeenV1';
      const digest=(value)=>{let hash=2166136261,text=String(value||'');for(let i=0;i<text.length;i+=1){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}return(hash>>>0).toString(16).padStart(8,'0');};
      const conversationId=()=>{const m=location.pathname.match(/(?:^|\\/)c\\/([^/?#]+)/i);return m?m[1]:'';};
      const readText=${readBoundedDomText.toString()};
      const clean=(node,limit)=>readText(node,limit,'button,[role="button"],pre,code,svg,nav,[data-testid*="tool"]');
      const latestPair=()=>{
        const turns=document.querySelectorAll('[data-testid^="conversation-turn-"]');
        let assistant=null,user=null,turnId='';
        for(let i=turns.length-1;i>=Math.max(0,turns.length-32);i--){
          const turn=turns[i];
          if(!assistant){assistant=turn.querySelector('[data-message-author-role="assistant"]');if(assistant)turnId=String(turn.dataset.testid||'');}
          if(assistant){user=turn.querySelector('[data-message-author-role="user"]');if(user){turnId=turnId||String(turn.dataset.testid||'');break;}}
        }
        if(!assistant||!user)return null;
        return {user:clean(user,6000),assistant:clean(assistant,8000),turnId};
      };
      const generating=()=>Array.from(document.querySelectorAll('button[data-testid="stop-button"],button[data-testid="stop-generating-button"],button[aria-label="停止"],button[aria-label*="停止生成"],button[aria-label="Stop"],button[aria-label*="Stop generating"]')).some(node=>getComputedStyle(node).visibility!=='hidden'&&node.getClientRects().length>0);
      const loadSeen=()=>{try{return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY)||'[]'));}catch{return new Set();}};
      const saveSeen=(seen)=>{try{sessionStorage.setItem(SEEN_KEY,JSON.stringify([...seen].slice(-160)));}catch{}};
      const scan=()=>{
        window.__mcpAutoMemoryTimer=0;
        if(generating())return;
        const pair=latestPair();
        if(!pair?.user||!pair.assistant)return;
        const id=conversationId(),stableKey=digest(id+'\\n'+pair.user+'\\n'+pair.assistant),seen=loadSeen(),dedupeKey=id+':'+stableKey;
        if(seen.has(dedupeKey))return;
        if(window.__mcpAutoMemoryStableKey!==stableKey){window.__mcpAutoMemoryStableKey=stableKey;window.__mcpAutoMemoryTimer=setTimeout(scan,1400);return;}
        seen.add(dedupeKey);saveSeen(seen);
        try{window.__mcpAutoMemoryQueue={conversation_id:id,turn_id:pair.turnId,user_text:pair.user,assistant_text:pair.assistant};console.info(PREFIX+'ready');}catch{}
      };
      const schedule=(delay=1800)=>{if(window.__mcpAutoMemoryTimer)clearTimeout(window.__mcpAutoMemoryTimer);window.__mcpAutoMemoryTimer=setTimeout(scan,delay);};
      const target=document.body||document.documentElement;
      if(!window.__mcpAutoMemoryObserver){
        window.__mcpAutoMemoryObserver=new MutationObserver(records=>{
          const main=document.querySelector('main')||target;
          if(records.some(record=>main===record.target||main.contains(record.target)||Array.from(record.addedNodes||[]).some(node=>node===main||node.contains?.(main))))schedule(1800);
        });
        if(target)window.__mcpAutoMemoryObserver.observe(target,{childList:true,subtree:true,characterData:true});
      }
      schedule(1200);return true;
    })()`, true).catch(()=>false);
  }

  scheduleStreamObserver() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.executeJavaScript(`(() => {
      const PREFIX='[web-mcp-stream] ';
      const STALE_AFTER_SECONDS=45;
      const DOCUMENT_ID=${JSON.stringify(this.streamDocumentRevision)};
      const conversationId=()=>(globalThis.location?.pathname||'').match(/(?:^|\\/)c\\/([^/]+)/)?.[1]||'';
      const RENDER_ERROR_MARKERS=${JSON.stringify(CHAT_RENDER_ERROR_MARKERS)};
      const STREAM_RECOVERY_ERROR_MARKERS=${JSON.stringify(CHAT_STREAM_RECOVERY_ERROR_MARKERS)};
      const MESSAGE_STREAM_ERROR_MARKERS=${JSON.stringify(CHAT_MESSAGE_STREAM_ERROR_MARKERS)};
      const readText=${readBoundedDomText.toString()};
      const normalize=(v)=>String(v||'').replace(/\\s+/g,' ').trim();
      const interrupted=(text)=>{
        const value=normalize(text);
        return (value.includes('连接已中断') && (value.includes('正在等待完整回复') || value.includes('正在等待完整答复')))
          || /Connection interrupted/i.test(value)
          || /Waiting for (?:the )?complete response/i.test(value);
      };
      const recoveryTimedOut=(text)=>{
        const value=normalize(text).toLowerCase();
        return STREAM_RECOVERY_ERROR_MARKERS.some((marker)=>value.includes(String(marker).toLowerCase()));
      };
      const visible=(node)=>{if(!node)return false;const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)return false;const rect=node.getBoundingClientRect();return rect.width>0&&rect.height>0;};
      const messageStreamError=()=>{
        const latest=Array.from(document.querySelectorAll('main [data-testid^="conversation-turn-"]')).at(-1);
        return Array.from(document.querySelectorAll('main [role="alert"],main [role="status"],main [data-testid*="error" i],main [class*="error" i]')).slice(-16).some(node=>{
          const turn=node.closest?.('[data-testid^="conversation-turn-"]');
          if(!visible(node)||turn&&turn!==latest||node.closest?.('pre,code'))return false;
          const value=normalize(readText(node,4096,'pre,code')).toLowerCase();
          return MESSAGE_STREAM_ERROR_MARKERS.some(marker=>value.startsWith(marker.toLowerCase()));
        });
      };
      const renderError=()=>Array.from(document.querySelectorAll('main [role="alert"],main [aria-live="assertive"],main [data-testid*="error" i],main [class*="error" i]')).slice(-8).some((node)=>{if(!visible(node))return false;const value=readText(node,4096,'pre,code').toLowerCase();return RENDER_ERROR_MARKERS.some((marker)=>value.includes(String(marker).toLowerCase()));});
      const report=(status,event,extra={})=>{try{console.info(PREFIX+JSON.stringify({status,event,document_id:DOCUMENT_ID,conversation_id:conversationId(),...extra}));}catch{}};
      const scan=()=>{
        window.__mcpStreamTimer=0;
        window.__mcpStreamNextScanAt=0;
        const notices=Array.from(document.querySelectorAll('main [role="alert"],main [role="status"],main [data-testid*="error" i]')).slice(-16).filter(visible);
        const text=notices.map(node=>readText(node,4096,'pre,code')).join(' ');
        if(messageStreamError()){
          const changed=window.__mcpStreamStatus!=='interrupted'||window.__mcpStreamErrorKind!=='message-stream';
          window.__mcpStreamStatus='interrupted';window.__mcpStreamErrorKind='message-stream';
          if(changed)report('interrupted','page-message-stream-error',{activity_at:window.__mcpStreamLastActivityAt||0,quiet_seconds:0,stalled:false,evidence:'page-dom'});
          return;
        }
        window.__mcpStreamErrorKind='';
        if(renderError()){
          const changed=window.__mcpStreamStatus!=='render_error';
          window.__mcpStreamStatus='render_error';
          if(changed)report('render_error','page-message-render-error',{activity_at:window.__mcpStreamLastActivityAt||0,quiet_seconds:0,stalled:false});
          return;
        }
        const stopSelector='button[data-testid="stop-button"],button[data-testid*="stop" i],button[aria-label="Stop"],button[aria-label*="Stop generating" i],button[aria-label="停止"],button[aria-label*="停止生成"]';
        const stopControls=Array.from(document.querySelectorAll(stopSelector));
        const isGenerationControl=(node)=>{const label=normalize(node.getAttribute('aria-label')||'').toLowerCase(),testId=node.getAttribute('data-testid')||'';return /^(停止|停止生成|停止生成回复|stop|stop generating|stop generating response)$/.test(label)||testId==='stop-button'||testId==='stop-generating-button';};
        const generating=stopControls.some((node)=>visible(node)&&!node.disabled&&node.getAttribute('aria-disabled')!=='true'&&isGenerationControl(node));
        const recoveryTimeout=recoveryTimedOut(text);
        const now=Date.now();
        const activityAt=Number(window.__mcpStreamLastActivityAt||now);
        const quietSeconds=generating?Math.max(0,Math.floor((now-activityAt)/1000)):0;
        const pageQuiet=generating&&quietSeconds>=STALE_AFTER_SECONDS;
        const stalled=false; // DOM silence cannot establish a model or MCP stall.
        if(generating){
          window.__mcpStreamStableIdleSince=0;
          window.__mcpStreamLastGeneratingAt=now;
        }else if(window.__mcpStreamStatus==='generating'){
          if(!window.__mcpStreamStableIdleSince){
            window.__mcpStreamStableIdleSince=now;
            schedule(1400);
            return;
          }
          const quietFor=now-window.__mcpStreamStableIdleSince;
          if(quietFor<1200){
            schedule(Math.max(150,1200-quietFor));
            return;
          }
        }else{
          window.__mcpStreamStableIdleSince=0;
        }
        const next=(recoveryTimeout||interrupted(text))?'interrupted':generating?'generating':'healthy';
        const quietBucket=Math.floor(quietSeconds/5);
        if(window.__mcpStreamStatus===next && window.__mcpStreamQuietBucket===quietBucket && window.__mcpStreamStalled===stalled && window.__mcpStreamReportedActivityAt===activityAt){
          if(generating)schedule(1000);
          return;
        }
        const previous=window.__mcpStreamStatus;
        window.__mcpStreamReportedActivityAt=activityAt;
        window.__mcpStreamStatus=next;
        window.__mcpStreamQuietBucket=quietBucket;
        window.__mcpStreamStalled=stalled;
        const extra={activity_at:activityAt,quiet_seconds:quietSeconds,stalled,page_quiet:pageQuiet,evidence:'page-dom'};
        if(next==='interrupted')report(next,recoveryTimeout?'page-stream-recovery-timeout':'page-stream-interrupted',extra);
        else if(next==='generating')report(next,'page-response-generating',extra);
        else if(previous==='interrupted')report(next,'page-stream-recovered',extra);
        else if(previous==='render_error')report(next,'page-message-render-recovered',extra);
        else if(previous==='generating')report(next,'page-response-finished',{...extra,settled_ms:Math.max(0,now-(window.__mcpStreamStableIdleSince||now))});
        if(generating)schedule(1000);
      };
      const schedule=(delay=500)=>{
        const dueAt=Date.now()+delay;
        if(window.__mcpStreamTimer&&dueAt>=window.__mcpStreamNextScanAt)return;
        if(window.__mcpStreamTimer)clearTimeout(window.__mcpStreamTimer);
        window.__mcpStreamNextScanAt=dueAt;
        window.__mcpStreamTimer=setTimeout(scan,delay);
      };
      const target=document.body||document.documentElement;
      if(!window.__mcpStreamLastActivityAt)window.__mcpStreamLastActivityAt=Date.now();
      if(window.__mcpStreamDocumentId!==DOCUMENT_ID){window.__mcpStreamObserver?.disconnect();window.__mcpStreamObserver=null;window.__mcpStreamLastActivityAt=Date.now();window.__mcpStreamStatus='unknown';window.__mcpStreamStableIdleSince=0;window.__mcpStreamDocumentId=DOCUMENT_ID;}
      if(!window.__mcpStreamObserver){window.__mcpStreamObserver=new MutationObserver((records)=>{const main=document.querySelector('main')||target;const relevant=records.some((record)=>main===record.target||main?.contains(record.target)||(record.type==='childList'&&Array.from(record.addedNodes||[]).some(node=>node===main||node.contains?.(main))));if(relevant){window.__mcpStreamLastActivityAt=Date.now();schedule(350);}});if(target)window.__mcpStreamObserver.observe(target,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['aria-label','aria-busy','aria-disabled','disabled','data-state','data-testid']});}
      schedule(250);
      return true;
    })()`, true).catch(()=>false);
  }

  scheduleContinuousMcpMode() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const enabled = this.settings.load().continuousMcpMode !== false;
    contents.executeJavaScript(`(() => {
      const ENABLED = ${JSON.stringify(enabled)};
      const APP_NAME = 'Coding Tools MCP';
      const STATE_KEY = '__webMcpContinuousConversations';
      const CAPABILITY_KEY = '__webMcpCapabilitySeen';
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const report = (event, detail = '', status = '') => {
        try { console.info('[web-mcp-continuous] ' + JSON.stringify({ event, detail, status })); } catch {}
      };
      const visible = (node) => {
        if (!(node instanceof Element)) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const conversationId = () => {
        const match = location.pathname.match(/(?:^|\\/)c\\/([^/?#]+)/i);
        return match ? match[1] : '';
      };
      const loadArmed = () => {
        try { return new Set(JSON.parse(sessionStorage.getItem(STATE_KEY) || '[]')); }
        catch { return new Set(); }
      };
      const saveArmed = (set) => {
        try { sessionStorage.setItem(STATE_KEY, JSON.stringify([...set].slice(-100))); } catch {}
      };
      const capabilitySeen = () => {
        try { return sessionStorage.getItem(CAPABILITY_KEY) === '1'; } catch { return false; }
      };
      const rememberCapability = (reason = '') => {
        if (capabilitySeen()) return;
        try { sessionStorage.setItem(CAPABILITY_KEY, '1'); } catch {}
        report('capability-seen', reason, 'available');
      };
      const editor = () => document.querySelector('#prompt-textarea,[data-testid="composer-input"] textarea,textarea[data-id="root"],form [contenteditable="true"]');
      const sendButton = () => document.querySelector('button[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="发送提示"],button[aria-label="发送消息"],button[aria-label="发送"]');
      const composerRoot = () => editor()?.closest('form') || editor()?.parentElement?.parentElement || document.querySelector('main form');
      const hasHistoricalMcpUse = () => {
        const userNodes = [...document.querySelectorAll('[data-message-author-role="user"]')];
        const key = conversationId() + ':' + userNodes.length;
        if (window.__webMcpHistoryKey === key) return Boolean(window.__webMcpHistoryMatch);
        window.__webMcpHistoryKey = key;
        window.__webMcpHistoryMatch = userNodes.some((node) => normalize((node.closest('[data-testid^="conversation-turn-"]') || node).textContent).includes(APP_NAME));
        return window.__webMcpHistoryMatch;
      };
      const armConversation = (reason = '') => {
        const id = conversationId();
        if (!id) return false;
        const armed = loadArmed();
        if (!armed.has(id)) {
          armed.add(id);
          saveArmed(armed);
          report('conversation-armed', reason || id.slice(-8), 'available');
        }
        return true;
      };
      const armFromHistory = () => {
        const id = conversationId();
        if (loadArmed().has(id)) return true;
        if (!id || !hasHistoricalMcpUse()) return false;
        rememberCapability('history');
        return armConversation(id.slice(-8));
      };
      const isArmed = () => {
        const id = conversationId();
        if (!id) return false;
        return loadArmed().has(id) || armFromHistory() || capabilitySeen();
      };
      const composerHasMcp = () => {
        const root = composerRoot();
        const input = editor();
        if (!root || !input) return false;
        const inputToken = [...input.querySelectorAll?.('[contenteditable="false"],[data-mention],[data-testid*="mention" i],button,[role="button"]') || []]
          .some((node) => visible(node) && normalize(node.innerText || node.textContent).includes(APP_NAME));
        if (inputToken) return true;
        return [...root.querySelectorAll('button,[role="button"],[data-testid],span')]
          .some((node) => node !== input && !input.contains(node) && visible(node) && normalize(node.innerText || node.textContent).includes(APP_NAME));
      };
      const toast = (message) => {
        document.getElementById('__webMcpContinuousToast')?.remove();
        const node = document.createElement('div');
        node.id = '__webMcpContinuousToast';
        node.textContent = message;
        Object.assign(node.style, {
          position: 'fixed', left: '50%', bottom: '92px', transform: 'translateX(-50%)', zIndex: '2147483647',
          maxWidth: '620px', padding: '10px 14px', borderRadius: '10px', color: '#fff', background: 'rgba(25,25,25,.94)',
          fontSize: '13px', lineHeight: '1.45', boxShadow: '0 8px 30px rgba(0,0,0,.22)'
        });
        document.body.appendChild(node);
        setTimeout(() => node.remove(), 4200);
      };
      const findMcpOption = () => {
        const direct = [...document.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemradio"]')]
          .find((node) => visible(node) && normalize(node.innerText || node.textContent).includes(APP_NAME));
        if (direct) return direct;
        const overlays = [...document.querySelectorAll('[role="listbox"],[role="menu"],[data-radix-popper-content-wrapper],[data-headlessui-portal]')].filter(visible);
        for (const overlay of overlays) {
          const match = [...overlay.querySelectorAll('button,[data-testid],[role="button"]')]
            .find((node) => visible(node) && normalize(node.innerText || node.textContent).includes(APP_NAME));
          if (match) return match;
        }
        return null;
      };
      const waitForOption = async (timeoutMs = 1800) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          const option = findMcpOption();
          if (option) {
            rememberCapability('catalog');
            return option;
          }
          await new Promise((resolve) => setTimeout(resolve, 90));
        }
        return null;
      };
      const waitForAttached = async (timeoutMs = 1400) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          if (composerHasMcp()) return true;
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        return false;
      };
      const snapshotEditor = (input) => ({
        html: input.isContentEditable ? input.innerHTML : '',
        value: 'value' in input ? String(input.value || '') : '',
        text: normalize(input.innerText || input.value || input.textContent)
      });
      const insertMentionTrigger = (input) => {
        input.focus();
        const selection = getSelection();
        if (selection && input.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(input);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        } else if ('selectionStart' in input) {
          input.selectionStart = input.selectionEnd = String(input.value || '').length;
        }
        document.execCommand('insertText', false, ' @' + APP_NAME);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' @' + APP_NAME }));
      };
      const restoreEditor = (input, snapshot) => {
        input.focus();
        try { document.execCommand('undo'); } catch {}
        const current = normalize(input.innerText || input.value || input.textContent);
        if (current !== snapshot.text) {
          if (input.isContentEditable) input.innerHTML = snapshot.html;
          else if ('value' in input) input.value = snapshot.value;
        }
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'historyUndo' }));
      };
      const attachAndSend = async () => {
        if (window.__webMcpContinuousBusy) return;
        window.__webMcpContinuousBusy = true;
        const input = editor();
        let inserted = false;
        const snapshot = input ? snapshotEditor(input) : null;
        try {
          if (!input) throw new Error('未找到 ChatGPT 输入框');
          if (!composerHasMcp()) {
            insertMentionTrigger(input);
            inserted = true;
            const option = await waitForOption();
            if (!option) {
              report('catalog-missing', '当前消息没有 Coding Tools MCP 选择项', 'unavailable');
              throw new Error('没有找到 Coding Tools MCP 选择项');
            }
            option.click();
            if (!(await waitForAttached())) throw new Error('Coding Tools MCP 未成功附加到本条消息');
            inserted = false;
          }
          rememberCapability('attached');
          armConversation('attached');
          const button = sendButton();
          if (!button) throw new Error('未找到发送按钮');
          window.__webMcpContinuousBypass = true;
          report('attach-success', conversationId().slice(-8), 'attached');
          button.click();
        } catch (error) {
          if (inserted && input && snapshot) restoreEditor(input, snapshot);
          const detail = String(error?.message || error);
          report('attach-failed', detail, detail.includes('没有找到 Coding Tools MCP') ? 'unavailable' : 'error');
          const fallbackButton = sendButton();
          if (fallbackButton) {
            window.__webMcpContinuousBypass = true;
            report('attach-fallback-send', detail, 'unavailable');
            toast('连续 MCP 自动附加失败，本条消息已按 ChatGPT 原生方式继续发送；不会要求手动 @Coding Tools MCP。');
            fallbackButton.click();
          } else {
            toast('连续 MCP 自动附加失败，且未找到发送按钮；请再次发送。');
          }
        } finally {
          setTimeout(() => { window.__webMcpContinuousBusy = false; window.__webMcpContinuousBypass = false; }, 0);
        }
      };
      // v0.3.1 hotfix: never intercept ChatGPT's native send path. The DOM
      // attachment flow is too brittle across ChatGPT composer revisions and a
      // missing MCP catalog entry must never make a user message unsendable.
      const shouldIntercept = () => false;
      const clickHandler = (event) => {
        if (window.__webMcpContinuousBypass) return;
        const button = event.target?.closest?.('button');
        if (!button || button !== sendButton() || !shouldIntercept()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        attachAndSend();
      };
      const keyHandler = (event) => {
        if (window.__webMcpContinuousBypass || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        const input = editor();
        if (!input || !(event.target === input || input.contains?.(event.target)) || !shouldIntercept()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        attachAndSend();
      };
      if (window.__webMcpContinuousHandlers) {
        document.removeEventListener('click', window.__webMcpContinuousHandlers.click, true);
        document.removeEventListener('keydown', window.__webMcpContinuousHandlers.keydown, true);
        try { window.__webMcpContinuousHandlers.observer?.disconnect(); } catch {}
        clearTimeout(window.__webMcpContinuousHandlers.timer);
        window.__webMcpContinuousHandlers = null;
      }
      if (!ENABLED) {
        report('disabled', '', 'disabled');
        return false;
      }
      const syncPageCapability = () => {
        handlers.timer = null;
        armFromHistory();
        if (composerHasMcp()) {
          rememberCapability('composer');
          armConversation('composer');
          if (handlers.status !== 'attached') report('composer-attached', conversationId().slice(-8), 'attached');
          handlers.status = 'attached';
        }
        const text = [...document.querySelectorAll('main [role="alert"],main [data-testid*="error" i]')].map(node => node.textContent || '').join(' ');
        if (/does not support developer mcps/i.test(text)) {
          report('developer-mcp-unsupported', 'ChatGPT 当前对话不支持 Developer MCP', 'unavailable');
        }
      };
      // Batch streaming mutations; never scan the entire transcript on each token.
      const handlers = { observer: null, timer: null, status: '' };
      const observer = new MutationObserver(() => {
        if (!handlers.timer) handlers.timer = setTimeout(syncPageCapability, 1500);
      });
      observer.observe(document.querySelector('main') || document.body, { childList: true, subtree: true });
      handlers.observer = observer;
      window.__webMcpContinuousHandlers = handlers;
      report('native-send-mode', capabilitySeen() ? 'session-capability-seen' : 'waiting-first-attachment', 'available');
      syncPageCapability();
      return true;
    })()`, true).catch((error) => {
      this.log.warn('连续 MCP 模式注入失败', { message: error.message });
    });
  }

  resize() {
    if (this.disposed || !this.view || this.view.webContents.isDestroyed() || !this.window || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    // WebContentsView is a native layer that always paints above HTML.
    // Reserve permanent shell panes; transient menus paint in a child window.
    const top = Math.min(Math.max(0, height), this.toolbarHeight + (this.topOverlay || 0));
    const bottom = Math.min(Math.max(0, height - top), Math.max(0, this.bottomInset || 0));
    const left = Math.min(Math.max(0, width - 240), this.leftInset || 0);
    const right = Math.min(Math.max(0, width - left - 240), this.rightInset || 0);
    const viewHeight = Math.max(0, height - top - bottom);
    this.view.setBounds({
      x: left,
      y: top,
      width: Math.max(0, width - left - right),
      height: viewHeight
    });
    for (const authView of this.liveAuthViews()) authView.setBounds({ x: left, y: this.toolbarHeight, width: Math.max(0, width - left - right), height: Math.max(0, height - this.toolbarHeight - bottom) });
  }

  emitState() {
    if (!this.disposed) this.onState(this.getState());
  }

  getState() {
    const contents = this.activeContents();
    return {
      loading: this.loading,
      error: this.lastError,
      errorLayer: this.errorLayer,
      retryAttempt: this.retryAttempt,
      nextRetryAt: this.nextRetryAt,
      url: contents && !contents.isDestroyed() ? contents.getURL() : '',
      title: contents && !contents.isDestroyed() ? contents.getTitle() : '',
      canGoBack: Boolean(contents && !contents.isDestroyed() && contents.canGoBack()),
      canGoForward: Boolean(contents && !contents.isDestroyed() && contents.canGoForward()),
      mcpAttachment: { ...this.mcpAttachment },
      browserNetwork: { ...this.browserNetwork },
      appearance: { ...this.chatAppearance },
      streamState: { ...this.streamState },
      nativeLogin: this.nativeLogin?.getState() || { status: 'idle', message: '', browser: '' },
      login: { ...this.login }
    };
  }

  async openUrl(url) {
    if (!isAllowedNavigation(url)) throw new Error('不允许在内联窗口打开该地址。');
    const contents = this.view?.webContents;
    if (this.disposed || !contents || contents.isDestroyed()) return false;
    if (contents.getURL() === url) return true;

    const target = parseUrl(url);
    const current = parseUrl(contents.getURL());
    if (target && current && target.origin === current.origin) {
      const targetPath = `${target.pathname}${target.search}${target.hash}`;
      try {
        const clicked = await contents.executeJavaScript(`(() => {
          const wanted = ${JSON.stringify(targetPath)};
          const link = Array.from(document.querySelectorAll('a[href]')).find((item) => {
            try { const parsed = new URL(item.href, location.href); return parsed.pathname + parsed.search + parsed.hash === wanted; }
            catch { return false; }
          });
          if (!link) return false;
          link.click();
          return true;
        })()`, true);
        if (clicked) return true;
      } catch { /* fall through */ }
    }

    if (this.disposed || contents.isDestroyed()) return false;

    contents.stop();
    this.pendingPageLoadReason = 'open-url';
    contents.loadURL(url).catch((error) => {
      this.lastError = error.message;
      this.emitState();
    });
    return true;
  }

  async loadHome() {
    return this.openUrl(CHAT_HOME);
  }

  async navigate(action) {
    const contents = this.activeContents();
    if (!contents || contents.isDestroyed()) return false;
    if (action === 'back' && contents.canGoBack()) contents.goBack();
    else if (action === 'forward' && contents.canGoForward()) contents.goForward();
    else if (action === 'reload' || action === 'recover') {
      this.clearRetryState();
      this.pendingPageLoadReason = 'user-navigation-reload';
      this.log.info('ChatGPT 页面重载', { host: parseUrl(contents.getURL())?.hostname || '', reason: this.pendingPageLoadReason });
      if (action === 'recover') contents.forcefullyCrashRenderer();
      if (typeof contents.reloadIgnoringCache === 'function') contents.reloadIgnoringCache();
      else contents.reload();
    }
    else if (action === 'home') { this.dismissLogin(); await this.loadHome(); }
    else throw new Error('不支持的导航操作。');
    this.emitState();
    return true;
  }

  async injectPrompt(text, autoSend = false) {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return false;
    const safeText = JSON.stringify(String(text || ''));
    const safeAutoSend = Boolean(autoSend);
    return contents.executeJavaScript(`(() => {
      try {
        const text = ${safeText};
        const autoSend = ${safeAutoSend};
        const candidates = [
          document.querySelector('#prompt-textarea'),
          document.querySelector('div[contenteditable="true"]'),
          document.querySelector('textarea[data-id="root"]'),
          document.querySelector('textarea')
        ].filter(Boolean);
        const input = candidates[0];
        if (!input) return false;
        input.focus();
        if (input.tagName.toLowerCase() === 'textarea') {
          input.value = text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          // contenteditable div
          input.innerText = text;
          input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        }
        if (autoSend) {
          setTimeout(() => {
            const sendBtn = document.querySelector('button[data-testid="send-button"]')
              || document.querySelector('button[aria-label="发送提示词"]')
              || document.querySelector('button[aria-label="Send prompt"]');
            if (sendBtn && !sendBtn.disabled) {
              sendBtn.click();
            } else {
              const enterEvt = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', keyCode: 13 });
              input.dispatchEvent(enterEvt);
            }
          }, 350);
        }
        return true;
      } catch {
        return false;
      }
    })()`, true).catch(() => false);
  }

  async stopGeneration() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return false;
    const clicked = await contents.executeJavaScript(`(() => {
      const selectors = [
        'button[data-testid="stop-button"]', 'button[data-testid*="stop" i]',
        'button[aria-label="Stop"]', 'button[aria-label*="Stop generating" i]',
        'button[aria-label="停止"]', 'button[aria-label*="停止生成"]'
      ];
      const visible = (node) => {
        if (!node || node.disabled || node.getAttribute('aria-disabled') === 'true') return false;
        const style = getComputedStyle(node); const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const button = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).find((node) => {
        const value = String(node.getAttribute('aria-label') || '') + ' ' + String(node.getAttribute('data-testid') || '');
        return value.trim() === '停止' || /(stop-button|stop generating|停止生成)/i.test(value) || (value.includes('stop') && !/(share|record|audio|speaking)/i.test(value)) ? visible(node) : false;
      });
      if (!button) return false;
      button.click();
      return true;
    })()`, true);
    if (clicked) this.scheduleStreamObserver();
    return Boolean(clicked);
  }

  async clearSession() {
    if (this.nativeLogin?.run) throw new Error('请先取消浏览器登录修复，再清理登录状态。');
    this.dismissLogin();
    this.loginPromptSeen.clear();
    const chatSession = session.fromPartition(CHAT_PARTITION);
    await chatSession.clearStorageData();
    await chatSession.clearCache();
    this.clearRetryState();
    this.lastError = '';
    this.errorLayer = '';
    await this.loadHome();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.chatAppearanceAbort.abort();
    this.loginRevision++;
    clearTimeout(this.loadTimer);
    clearTimeout(this.enhancementTimer);
    for (const { contents, name, guarded } of this.contentBindings.splice(0)) contents.removeListener(name, guarded);
    clearInterval(this.loginWatch);
    this.closeAuthViews();
    Promise.resolve(this.nativeLogin?.cancel()).catch((error) => this.log.warn('退出时登录清理失败', { message: error.message }));
    for (const view of this.downloadViews.splice(0)) {
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    }
    this.clearRetryState();
    if (this.window && !this.window.isDestroyed()) this.window.removeListener('resize', this.boundResize);
    if (this.view && this.window && !this.window.isDestroyed()) {
      try { this.window.contentView.removeChildView(this.view); } catch { /* already detached */ }
    }
    if (this.view?.webContents && !this.view.webContents.isDestroyed()) {
      this.view.webContents.close({ waitForBeforeUnload: false });
    }
    this.view = null;
  }

  startNativeLogin() {
    this.dismissLogin();
    this.setLogin({ status: 'waiting', mode: 'native', prompt: true, kind: '', message: '请在新打开的浏览器窗口完成登录。助手会自动检查并返回，无需找返回按钮。' });
    if (!this.nativeLogin) {
      if (!this.nativeLoginRoot) throw new Error('登录修复目录未初始化。');
      this.nativeLogin = new NativeLoginService({
        root: this.nativeLoginRoot,
        session: session.fromPartition(CHAT_PARTITION),
        settings: () => this.settings.load(),
        onState: (state) => {
          if (this.disposed) return;
          const finished = ['success', 'idle'].includes(state.status);
          this.setLogin({ status: state.status, mode: finished ? '' : 'native', prompt: !finished, message: state.cleanupWarning || state.message });
          if (state.status === 'success' && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); }
        },
        verify: async () => {
          const contents = this.view?.webContents;
          if (!contents || contents.isDestroyed()) return false;
          const bounded = async (promise, ms) => {
            let timer;
            try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('登录验证超时')), ms); })]); }
            finally { clearTimeout(timer); }
          };
          try {
            this.clearRetryState();
            await bounded(contents.loadURL(CHAT_HOME), 15000);
            if (!isChatGptNavigation(contents.getURL())) return false;
            return await bounded(contents.executeJavaScript(SESSION_CHECK), 10000) === true;
          } catch { return false; }
        }
      });
    }
    return this.nativeLogin.start();
  }

  finishNativeLogin() {
    if (!this.nativeLogin) throw new Error('请先打开浏览器登录窗口。');
    return this.nativeLogin.finish();
  }

  cancelNativeLogin() { return this.nativeLogin?.cancel() || { status: 'idle', message: '', browser: '' }; }
}

module.exports = {
  bindChatNetworkDiagnostics,
  ChatViewController,
  CHAT_HOME,
  CHAT_PARTITION,
  chromeLikeUserAgent,
  browserProxyConfig,
  proxyRouteKey,
  isAllowedNavigation,
  isAuthPopup,
  isChatGptNavigation,
  isTransientChatLoadError,
  isChatConversationUrl,
  isChatDownloadUrl,
  isChatMessageRenderErrorText,
  isChatStreamRecoveryTimeoutText
};
