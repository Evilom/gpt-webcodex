const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'think-tank-renderer-smoke-')));

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'build', 'ui-smoke');
const demoWorkspace = 'C:\\smoke\\workspace';
let currentTheme = 'light';
const smokeWindows = [];
const probeLayout = require('./ui-layout-probe');

function ok(data) { return { ok: true, data }; }

function snapshot() {
  return {
    appVersion: require('../package.json').version + '-smoke',
    settings: {
      theme: currentTheme,
      workspace: demoWorkspace,
      tunnelId: 'tunnel_smoke_renderer',
      mcpPort: 18765,
      healthPort: 18081,
      proxyMode: 'auto',
      proxyUrl: '',
      startWithWindows: false,
      autoStartServices: false,
      keepRunningOnClose: true,
      taskNotifications: true,
      taskNotificationSound: false
    },
    secrets: { runtimeApiKey: true },
    environment: { proxy: { reachable: true, resolvedUrl: 'direct' } },
    status: {
      runtimeRunning: true,
      tunnelRunning: true,
      connectionRunning: true,
      localMcpUrl: 'http://127.0.0.1:18765/mcp',
      schemaIdentity: { version: '0.9.2-smoke', schemaVersion: 14, schemaHash: 'smoke', toolCount: 10 },
      tunnelDiagnostics: { tunnelName: 'smoke-renderer', mainChannelReady: true, mainChannelProbe: 'ok' }
    },
    chat: { mcpAttachment: { status: 'attached', detail: 'smoke renderer' } }
  };
}

function taskRuntime() {
  const now = new Date().toISOString();
  return {
    state: {
      task_id: 'smoke_task',
      run_id: 'smoke_run',
      status: 'waiting',
      lifecycle_state: 'waiting_model',
      objective: 'Renderer smoke',
      current_step: '等待模型',
      updated_at: now,
      last_heartbeat_at: now
    },
    operations: [],
    activity: { latest: [] },
    runtime_layers: {
      connection: { state: 'connected', transport: 'mcp' },
      execution: { state: 'waiting', lifecycle: 'waiting_model', status: 'waiting' },
      model: { state: 'waiting', wait_reason: 'model' },
      process: { state: 'idle' },
      recovery: { state: 'healthy', attempt: 0 },
      user: { state: 'waiting_model', stalled: false, suspected_stall: false, quiet: false, heartbeat_age_seconds: 0 },
      workspace: { state: 'ready', path: demoWorkspace }
    }
  };
}

function workspaceHub() {
  return {
    activeWorkspace: demoWorkspace,
    workspaces: [{ path: demoWorkspace, name: 'workspace', active: true, status: 'ready' }],
    recentWorkspaces: [demoWorkspace],
    authorizedRoots: [demoWorkspace],
    invalidCount: 0
  };
}

function installHandlers() {
  const handlers = {
    'update:status': () => ok({ current: require('../package.json').version, latest: '0.9.8', stage: 'available', manual: false, progress: 0 }),
    'update:check': () => ok({ current: require('../package.json').version, latest: '0.9.8', stage: 'available', manual: false, progress: 0 }),
    'app:snapshot': () => ok(snapshot()),
    'workspace:hub': () => ok(workspaceHub()),
    'task-state:read': () => ok({ state: taskRuntime().state }),
    'mcp:task-runtime': () => ok(taskRuntime()),
    'mcp:task-worktrees': () => ok({ worktrees: [] }),
    'memory:control': (_event, request = {}) => ok(request.action === 'status'
      ? { count: 1, active_count: 1, archived_count: 0, candidate_count: 0, config: { auto_memory: 'off' } }
      : { items: request.action === 'candidates' ? [] : [{ memory_id: 'theme-memory', title: '工程上下文', category: 'project_context', content: '保留工作区与已确认的工程约束。', source: 'model_summary', updated_at: '2026-10-14T01:38:04Z' }] }),
    'app:lightweight-snapshot': () => ok({ workspace: demoWorkspace, mcpRunning: true, tunnelRunning: true, connectionRunning: true, fullyReady: true }),
    'advisory:status': () => ok({ configured: false, models: [], selected: [], job: null }),
    'image-jobs:status': () => ok({ configured: false, enabled: false, last_request_id: '' }),
    'chat:status': () => ok({ url: 'https://chatgpt.com/', loading: false }),
    'shell-popover:update': () => ok(false),
    'approval:list': () => ok({ items: [] }),
    'context:usage': () => ok({ totalTokens: 0, totalBytes: 0, percent: 0, level: 'safe', topTools: [] }),
    'checkpoint:status': () => ok({ hasCapsule: false, canRollback: false }),
    'task:read-console': () => ok({ status: 'waiting', logs: ['Renderer console smoke'], modifiedFiles: [] }),
    'task-state:history': () => ok({ items: [{ task_id: 'history-smoke', status: 'completed', objective: '历史接口兼容验证' }] }),
    'chat:set-content-insets': () => ok(true),
    'activity-detail:show': () => ok(true),
    'activity-detail:update': () => ok(true),
    'activity-detail:hide': () => ok(true),
    'activity-detail:close': () => ok(true),
    'logs:read': () => ok([])
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    try { ipcMain.removeHandler(channel); } catch {}
    ipcMain.handle(channel, handler);
  }
}

async function waitForRenderer(win, theme) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const state = await win.webContents.executeJavaScript(`(() => ({
      booting: document.body.classList.contains('booting'),
      theme: document.body.dataset.theme || '',
      themeMode: document.body.dataset.themeMode || '',
      title: document.querySelector('#overallTitle')?.textContent || '',
      slots: Array.from(document.querySelectorAll('[data-react-slot]')).map((node) => ({ key: node.getAttribute('data-react-slot'), text: node.textContent.trim() })),
      width: { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }
    }))()`);
    const mounted = state.slots.length === 4 && state.slots.every((slot) => slot.text.length > 0);
    if (!state.booting && mounted) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Renderer smoke timed out for ${theme}`);
}

async function capturePageStable(win, theme) {
  // Keep the isolated fixture offscreen while its compositor renders a real frame.
  const bounds = win.getBounds();
  win.setBounds({ ...bounds, x: -10000, y: -10000 }, false);
  win.showInactive();
  await new Promise(resolve => setTimeout(resolve, 180));
  try {
    for(let attempt=0;attempt<3;attempt++) {
      try {
        const image = await win.capturePage();
        if (image.isEmpty()) throw new Error(`Empty capture for ${theme}`);
        return image;
      } catch(error) {
        if(attempt===2 || !/UnknownVizError|surface|Empty capture/i.test(error.message)) throw error;
        await new Promise(resolve=>setTimeout(resolve,250));
      }
    }
  } finally {
    win.hide(); win.setBounds(bounds, false);
  }
}

async function runTheme(theme) {
  currentTheme = theme;
  const errors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 960,
    backgroundColor: theme === 'light' ? '#ffffff' : '#000000',
    webPreferences: {
      preload: path.join(root, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  smokeWindows.push(win);

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) errors.push({ type: 'console', level, message, line, sourceId });
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => errors.push({ type: 'preload', preloadPath, message: error?.stack || error?.message || String(error) }));
  win.webContents.on('render-process-gone', (_event, details) => errors.push({ type: 'render-process-gone', details }));
  win.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (isMainFrame) errors.push({ type: 'did-fail-load', code, description, validatedURL });
  });

  await win.loadFile(path.join(root, 'renderer', 'index.html'), { query: { theme } });
  const state = await waitForRenderer(win, theme);
  const image = await capturePageStable(win, theme);
  const pngPath = path.join(outDir, `${theme}.png`);
  fs.writeFileSync(pngPath, image.toPNG());

  const pages = [];
  for (const page of ['status', 'workspace', 'memory', 'settings', 'setup-guide']) {
    await win.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    const appearance = await win.webContents.executeJavaScript(`(() => {
      const css = getComputedStyle(document.body);
      const text = Array.from(document.querySelectorAll('.page.active *,.sidebar *,.topbar *')).filter(el=>el.getClientRects().length && Array.from(el.childNodes).some(n=>n.nodeType===3 && n.textContent.trim()));
      return {bg:css.backgroundColor,surfaces:['.app-shell','.sidebar','.topbar'].map(selector=>getComputedStyle(document.querySelector(selector)).backgroundColor),selection:document.getElementById('themeSelect').value,themeLabel:document.querySelector('[data-react-slot="settings"]').textContent,size:parseFloat(css.fontSize),small:text.filter(el=>parseFloat(getComputedStyle(el).fontSize)<12).map(el=>({class:el.className,size:getComputedStyle(el).fontSize})),overflow:document.documentElement.scrollWidth>innerWidth};
    })()`);
    if (appearance.bg !== (theme === 'black' ? 'rgb(0, 0, 0)' : theme === 'dark' ? 'rgb(21, 21, 21)' : 'rgb(252, 252, 251)') || appearance.size !== 14 || appearance.small.length || appearance.overflow) throw new Error(`Manager appearance ${theme}/${page}: ${JSON.stringify(appearance)}`);
    if (theme === 'black') {
      assert.deepEqual(appearance.surfaces, ['rgb(0, 0, 0)','rgb(0, 0, 0)','rgb(0, 0, 0)']);
      assert.equal(appearance.selection,'black'); assert.ok(appearance.themeLabel.includes('纯黑'));
    }
    const layouts=[];
    for (const width of [1440,980,820]) {
      win.setContentSize(width,width===820?640:720);
      await win.webContents.executeJavaScript(`document.querySelectorAll('.page.active details').forEach(el=>el.open=true)`);
      await new Promise(resolve => setTimeout(resolve,80));
      const layout=await win.webContents.executeJavaScript(`(${probeLayout.toString()})('.topbar,.section-header,.hero-status,.panel-title,.memory-mode-panel,.memory-bulk-toolbar,.memory-toolbar,.memory-pagination,.setting-row,.settings-section-heading,.react-insight-strip,.setup-link-row,.input-action.wide')`);
      assert.ok(layout.scrollbars.length&&layout.scrollbars.every(s=>s.width==='6px'&&s.track==='rgba(0, 0, 0, 0)'&&s.buttons==='none'&&s.nativeWidth==='auto'),'shared manager scrollbars');
      const reading=await win.webContents.executeJavaScript(`(() => {
        const viewport=document.querySelector('.content-viewport');viewport.scrollTop=viewport.scrollHeight;
        const end=document.querySelector('.page.active').getBoundingClientRect().bottom<=viewport.getBoundingClientRect().bottom+2;
        viewport.scrollTop=0;
        return {end,viewportHeight:viewport.clientHeight,insightHeight:document.querySelector('.page.active .react-insight-strip')?.getBoundingClientRect().height||0,memoryFont:document.querySelector('.page.active .memory-content')?getComputedStyle(document.querySelector('.page.active .memory-content')).fontSize:null};
      })()`);
      fs.writeFileSync(path.join(outDir, `manager-${page}-${theme}-${width}-expanded.png`),(await capturePageStable(win,theme)).toPNG());
      if(layout.bodyOverflow || layout.issues.length) throw new Error(`Expanded manager ${theme}/${page}/${width}: ${JSON.stringify(layout)}`);
      if(!reading.end || reading.viewportHeight<200 || reading.insightHeight>190 || reading.memoryFont&&reading.memoryFont!=='16px') throw new Error(`Expanded reading ${theme}/${page}/${width}: ${JSON.stringify(reading)}`);
      layouts.push({width,layout,reading});
    }
    pages.push({page,appearance,layouts});
  }

  const fatalErrors = errors.filter((item) => {
    const text = JSON.stringify(item);
    return item.type !== 'console' || /ReferenceError|TypeError|Uncaught|process is not defined|Failed to load/i.test(text);
  });
  if (state.theme !== (theme === 'black' ? 'dark' : theme) || state.themeMode !== theme) throw new Error(`Expected ${theme} theme, got ${state.themeMode || 'empty'}`);
  if (state.width.scroll > state.width.client + 2) throw new Error(`Horizontal overflow in ${theme}: ${state.width.scroll} > ${state.width.client}`);
  if (fatalErrors.length) throw new Error(`Renderer errors in ${theme}: ${JSON.stringify(fatalErrors)}`);

  return { theme, state, pages, errors, screenshot: path.relative(root, pngPath).replaceAll('\\', '/') };
}

function destroySmokeWindows() {
  for (const win of smokeWindows.splice(0)) {
    try { if (!win.isDestroyed()) win.destroy(); } catch {}
  }
}

async function runBrowser(theme, width) {
  const errors = [];
  const win = new BrowserWindow({
    show: false, width, height: 900,
    webPreferences: { preload: path.join(root, 'electron', 'browserPreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  smokeWindows.push(win);
  win.webContents.on('preload-error', (_event, _path, error) => errors.push(String(error)));
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && /ReferenceError|TypeError|Uncaught/i.test(message)) errors.push(message);
  });
  await win.loadFile(path.join(root, 'renderer', 'browser.html'), { query: { theme } });
  await win.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 400))`);
  const state = await win.webContents.executeJavaScript(`(() => {
    const required = ['openTerminalButton', 'taskChangesBtn', 'openTaskHistoryButton', 'workspacePickerButton'];
    for (const id of required) if (!document.getElementById(id)) throw new Error('missing browser tool: ' + id);
    for (const id of ['recoverPageButton', 'updateAction']) {
      const node = document.getElementById(id);
      if (node.hidden && getComputedStyle(node).display !== 'none') throw new Error('hidden action is visible: ' + id);
    }
    document.getElementById('openTerminalButton').click();
    document.getElementById('consoleTabFiles').click();
    return {
      theme: document.body.dataset.theme,
      themeMode: document.body.dataset.themeMode,
      toolbarHeight: document.querySelector('.browser-toolbar').getBoundingClientRect().height,
      consoleOpen: !document.getElementById('taskConsoleDrawer').hidden,
      filesOpen: !document.getElementById('consoleFilesView').hidden,
      overflow: Array.from(document.querySelectorAll('.toolbar-main > *, .workspace-bar > *, .progress-band > *'))
        .filter((node) => !node.hidden && getComputedStyle(node).display !== 'none')
        .filter((node) => node.getBoundingClientRect().right > innerWidth + 2).map((node) => node.id || node.className)
    };
  })()`);
  if (state.theme !== (theme === 'black' ? 'dark' : theme) || state.themeMode !== theme || state.toolbarHeight < 56 || state.toolbarHeight > 58 || !state.consoleOpen || !state.filesOpen || state.overflow.length || errors.length) {
    throw new Error(`Browser integration smoke failed: ${JSON.stringify({ theme, width, state, errors })}`);
  }
  await win.webContents.executeJavaScript(`document.getElementById('closeConsoleBtn').click(); document.getElementById('openTaskHistoryButton').click();`);
  await win.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 200))`);
  const history = await win.webContents.executeJavaScript(`document.getElementById('taskHistoryList').textContent`);
  if (!history.includes('历史接口兼容验证')) throw new Error('Browser history failed to consume upstream items response');
  await win.webContents.executeJavaScript(`document.getElementById('openTerminalButton').click(); document.getElementById('consoleTabFiles').click();`);
  await win.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))))`);
  const image = await capturePageStable(win, theme);
  const screenshot = path.join(outDir, `browser-${theme}-${width}.png`);
  fs.writeFileSync(screenshot, image.toPNG());
  return { theme, width, state, screenshot: path.relative(root, screenshot).replaceAll('\\', '/') };
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  installHandlers();
  const results = [];
  try {
    results.push(await runTheme('light'));
    results.push(await runTheme('dark'));
    results.push(await runTheme('black'));
    const browserResults = [];
    for (const theme of ['light', 'dark', 'black']) {
      for (const width of [960, 1360]) browserResults.push(await runBrowser(theme, width));
    }
    const report = { ok: true, generatedAt: new Date().toISOString(), results, browserResults };
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(report, null, 2));
    console.log(`Renderer smoke PASS: ${results.map((item) => item.theme).join(', ')}`);
    destroySmokeWindows();
    app.exit(0);
  } catch (error) {
    const report = { ok: false, generatedAt: new Date().toISOString(), error: error?.stack || error?.message || String(error), results };
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(report, null, 2));
    console.error(report.error);
    destroySmokeWindows();
    app.exit(1);
  }
});
