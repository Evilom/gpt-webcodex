const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { app, BrowserWindow, dialog, ipcMain, shell, Tray, Menu, nativeImage, session, Notification } = require('electron');
const { SettingsStore } = require('./services/settingsStore');
const { SecretStore } = require('./services/secretStore');
const { LogService } = require('./services/logService');
const { EnvironmentService } = require('./services/environmentService');
const { RuntimeOrchestrator } = require('./services/runtimeOrchestrator');
const { ChatViewController } = require('./chatViewController');
const { run } = require('./services/commandRunner');
const { resolveProxy, clearProxyCache } = require('./services/proxyService');
const { BuildVerificationService } = require('./services/buildVerificationService');
const { HealthService } = require('./services/healthService');
const { readJson, writeJsonAtomic } = require('./services/jsonStore');
const { LocalMcpClient } = require('./services/localMcpClient');
const { TaskNotificationService } = require('./services/taskNotificationService');
const { NotificationCheckpointStore } = require('./services/notificationCheckpointStore');
const { ContextUsageTracker } = require('./services/contextUsageTracker');
const { notificationStateFile, mcpLogFile } = require('./paths');
const { stageAndCommit } = require('./services/safeGitOps');
const {
  createCheckpoint: createSafeCheckpoint,
  rollbackCheckpoint: rollbackSafeCheckpoint,
  loadCheckpointMeta,
} = require('./services/safeCheckpoint');
const { ApprovalStore } = require('./services/approvalStore');
const { writeHandoffFile } = require('./services/handoffService');

const approvalStore = new ApprovalStore();

let chatWindow;
let managerWindow;
let chatController;
let orchestrator;
let forceQuit = false;
let tray = null;
let buildVerification;
let healthService;
let taskNotificationService;
let superviseTimer = null;
let sharedLocalMcpClient = null;
const contextUsageTracker = new ContextUsageTracker();
const settings = new SettingsStore();
const secrets = new SecretStore();
const log = new LogService();
const environment = new EnvironmentService();
const notificationCheckpoints = new NotificationCheckpointStore(notificationStateFile);

if (process.platform === 'win32') app.setAppUserModelId('com.gptwebcodex.assistant');

function appIconPath() {
  return path.join(__dirname, 'app-icon.png');
}

function sendManager(channel, payload) {
  if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.send(channel, payload);
}

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isTrustedRendererUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return false;
  try {
    const parsed = new URL(url);
    let filePath = decodeURIComponent(parsed.pathname);
    if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(filePath)) {
      filePath = filePath.slice(1);
    }
    const normalizedFile = path.resolve(filePath).toLowerCase();
    const rendererDir = path.resolve(__dirname, '..', 'renderer').toLowerCase();
    const rendererPrefix = rendererDir.endsWith(path.sep) ? rendererDir : `${rendererDir}${path.sep}`;
    return normalizedFile === rendererDir || normalizedFile.startsWith(rendererPrefix);
  } catch {
    return false;
  }
}

function isPathInside(root, fullPath) {
  const normalizedRoot = path.resolve(String(root || ''));
  const normalizedFull = path.resolve(String(fullPath || ''));
  if (normalizedFull === normalizedRoot) return true;
  const rootPrefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedFull.startsWith(rootPrefix);
}

function assertPathInsideWorkspace(root, relativeOrAbsolute, label = '路径') {
  const full = path.isAbsolute(String(relativeOrAbsolute || ''))
    ? path.resolve(relativeOrAbsolute)
    : path.resolve(root, String(relativeOrAbsolute || ''));
  if (!isPathInside(root, full)) {
    throw new Error(`${label}越界：目标不在当前工作区内。`);
  }
  return full;
}

function isProtectedWorkspaceRel(rel) {
  const normalized = String(rel || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  return !normalized
    || normalized === '.'
    || normalized.startsWith('.coding-tools/')
    || normalized === '.coding-tools';
}

function assertTrustedIpc(event) {
  const url = event.senderFrame?.url || event.sender?.getURL?.() || '';
  if (!url.startsWith('file://')) throw new Error('已阻止来自非本地页面的 IPC 调用。');
  if (!isTrustedRendererUrl(url)) throw new Error('已阻止来自未授权本地页面的 IPC 调用。');
}

function secureHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpc(event);
    return handler(event, ...args);
  });
}

function workspaceStatePaths() {
  const workspace = String(settings.load().workspace || '').trim();
  if (!workspace) throw new Error('请先选择工作目录。');
  const root = path.resolve(workspace);
  return {
    root,
    statePath: path.join(root, '.coding-tools', 'task-state.json'),
    historyPath: path.join(root, '.coding-tools', 'task-history.json'),
    performancePath: path.join(root, '.coding-tools', 'performance.json')
  };
}

function workspaceCapsulePaths() {
  const { root, statePath } = workspaceStatePaths();
  const capsuleDir = path.join(root, '.coding-tools', 'capsules');
  const capsuleMetaPath = path.join(root, '.coding-tools', 'capsule-state.json');
  return { root, statePath, capsuleDir, capsuleMetaPath };
}

function archiveTask(state, historyPath, reason) {
  if (!state || typeof state !== 'object' || (!state.task_id && !state.objective)) return;
  const history = readJson(historyPath, []);
  const items = Array.isArray(history) ? history : [];
  items.push({ ...state, archived_at: new Date().toISOString(), archive_reason: reason });
  writeJsonAtomic(historyPath, items.slice(-100));
}

async function invokeSafely(action) {
  try { return { ok: true, data: await action() }; }
  catch (error) { return { ok: false, error: safeMessage(error) }; }
}

async function callLocalMcpTool(name, args = {}) {
  const current = settings.load();
  const token = secrets.get('mcpAuthToken');
  if (!token) throw new Error('本地 MCP 尚未生成认证 Token。');
  if (!sharedLocalMcpClient) sharedLocalMcpClient = new LocalMcpClient({ port: current.mcpPort, token, log });
  else sharedLocalMcpClient.configure({ port: current.mcpPort, token });
  const client = sharedLocalMcpClient;
  if (!client.tools.length) await client.discoverTools();
  let result;
  try {
    result = await client.callTool(name, args);
  } catch (error) {
    client.resetDiscoveryState();
    if (!localMcpCallCanRetry(name, args)) throw error;
    await client.discoverTools();
    result = await client.callTool(name, args);
  }
  if (result?.isError) {
    const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
    contextUsageTracker.recordToolCall(name, args, { error: text || `${name} 调用失败。` });
    throw new Error(text || `${name} 调用失败。`);
  }
  const payload = result?.structuredContent ?? result;
  contextUsageTracker.recordToolCall(name, args, payload);
  return payload;
}

function invalidateLocalMcpDiscovery() {
  sharedLocalMcpClient?.resetDiscoveryState();
}

function localMcpCallCanRetry(name, args = {}) {
  if (name === 'workspace_context' || name === 'coding_tools_guide') return true;
  if (name !== 'task_control') return false;
  return ['get', 'history', 'operation', 'worktree_list', 'worktree_get', 'worktree_diff']
    .includes(String(args?.action || 'get').toLowerCase());
}

function showChatWindow() {
  const target = createChatWindow();
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  return target;
}

function trayStatusText(status) {
  if (!status) return '网页 MCP 助手 · 服务未启动';
  if (status.fullyReady) return '网页 MCP 助手 · 服务已就绪';
  if (status.mcpRunning) return '网页 MCP 助手 · 等待连接通道';
  return '网页 MCP 助手 · 服务未启动';
}

function updateTrayTooltip(status) {
  if (tray && !tray.isDestroyed()) tray.setToolTip(trayStatusText(status));
}

function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  const icon = nativeImage.createFromPath(appIconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip(trayStatusText(null));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开网页 MCP 助手', click: () => showChatWindow() },
    { label: '打开管理设置', click: () => { showChatWindow(); openManagerWindow(); } },
    { type: 'separator' },
    { label: '退出助手（保留 MCP 服务）', click: () => { forceQuit = true; app.quit(); } }
  ]));
  tray.on('click', () => showChatWindow());
  tray.on('double-click', () => showChatWindow());
  return tray;
}

function createChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.show();
    chatWindow.focus();
    return chatWindow;
  }

  const initialTheme = settings.load().theme === 'light' ? 'light' : 'dark';
  chatWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: initialTheme === 'dark' ? '#000000' : '#f7f7f8',
    title: '网页 MCP 助手',
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'browserPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  chatWindow.removeMenu();
  chatWindow.loadFile(path.join(__dirname, '..', 'renderer', 'browser.html'), { query: { theme: initialTheme } });

  chatController = new ChatViewController({
    window: chatWindow,
    log,
    settings,
    toolbarHeight: 112,
    onState: (payload) => {
      if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('chat:state', payload);
    },
    onDownload: (payload) => {
      if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('chat:download', payload);
    }
  });
  chatController.mount();

  chatWindow.once('ready-to-show', () => chatWindow.show());
  chatWindow.on('closed', () => {
    if (chatController) chatController.dispose();
    chatController = null;
    chatWindow = null;
    if (managerWindow && !managerWindow.isDestroyed()) managerWindow.destroy();
  });
  chatWindow.on('close', (event) => {
    if (forceQuit) return;
    event.preventDefault();
    if (settings.load().keepRunningOnClose) {
      if (managerWindow && !managerWindow.isDestroyed()) managerWindow.hide();
      chatWindow.hide();
      return;
    }
    if (!orchestrator) {
      forceQuit = true;
      app.quit();
      return;
    }
    orchestrator.stop().catch((error) => log.error(error.message, { stage: 'close' })).finally(() => {
      forceQuit = true;
      app.quit();
    });
  });
  return chatWindow;
}

function openManagerWindow() {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.show();
    managerWindow.focus();
    return managerWindow;
  }

  const chatBounds = chatWindow && !chatWindow.isDestroyed() ? chatWindow.getBounds() : null;
  const width = 980;
  const height = 720;
  const x = chatBounds ? Math.round(chatBounds.x + Math.max(0, (chatBounds.width - width) / 2)) : undefined;
  const y = chatBounds ? Math.round(chatBounds.y + Math.max(0, (chatBounds.height - height) / 2)) : undefined;

  managerWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 820,
    minHeight: 580,
    show: false,
    skipTaskbar: true,
    frame: false,
    transparent: false,
    backgroundColor: '#f7f7f8',
    title: '网页 MCP 助手 · 管理中心',
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  managerWindow.removeMenu();
  const initialTheme = settings.load().theme === 'light' ? 'light' : 'dark';
  managerWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { theme: initialTheme } });
  managerWindow.once('ready-to-show', () => managerWindow.show());
  managerWindow.on('close', (event) => {
    if (forceQuit) return;
    event.preventDefault();
    managerWindow.hide();
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.show();
      chatWindow.focus();
    }
  });
  managerWindow.on('closed', () => { managerWindow = null; });
  return managerWindow;
}

function registerIpc() {
  secureHandle('app:snapshot', (_event, options) => invokeSafely(() => orchestrator.snapshot(options || {})));
  secureHandle('app:lightweight-snapshot', () => invokeSafely(() => orchestrator.lightweightSnapshot()));
  secureHandle('workspace:hub', () => invokeSafely(async () => { const current = settings.load(); return { activeWorkspace: current.workspace, recentWorkspaces: current.recentWorkspaces || [] }; }));
  secureHandle('workspace:remove-recent', (_event, targets) => invokeSafely(() => orchestrator.removeRecentWorkspaces(targets)));
  secureHandle('workspace:clear-active', () => invokeSafely(async () => {
    const result = await orchestrator.clearActiveWorkspace();
    invalidateLocalMcpDiscovery();
    taskNotificationService?.reset();
    return result;
  }));
  secureHandle('workspace:switch', (_event, workspace) => invokeSafely(async () => {
    const result = await orchestrator.switchWorkspace(workspace);
    invalidateLocalMcpDiscovery();
    taskNotificationService?.reset();
    taskNotificationService?.restartStream();
    return result;
  }));
  secureHandle('workspace:authorized-roots', (_event, roots) => invokeSafely(() => orchestrator.updateAuthorizedRoots(roots)));
  secureHandle('workspace:choose-authorized-root', () => invokeSafely(async () => {
    const result = await dialog.showOpenDialog(chatWindow, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = path.resolve(result.filePaths[0]);
    const current = settings.load();
    const roots = Array.isArray(current.authorizedRoots) ? current.authorizedRoots : [];
    const key = selected.toLowerCase();
    const merged = roots.some((item) => String(item).toLowerCase() === key) ? roots : [...roots, selected];
    const snapshot = await orchestrator.updateAuthorizedRoots(merged);
    return { selected, snapshot };
  }));
  secureHandle('task-state:read', () => invokeSafely(async () => {
    let statePath;
    try { ({ statePath } = workspaceStatePaths()); } catch { return { exists: false, state: null }; }
    try {
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      return { exists: true, statePath, state };
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, statePath, state: null };
      throw new Error(`任务状态读取失败：${safeMessage(error)}`);
    }
  }));
  secureHandle('task-state:clear', () => invokeSafely(async () => {
    let paths;
    try { paths = workspaceStatePaths(); } catch { return false; }
    const { statePath, historyPath } = paths;
    archiveTask(readJson(statePath, null), historyPath, 'cleared-from-assistant');
    await fs.unlink(statePath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    return true;
  }));
  secureHandle('task-state:pause', () => invokeSafely(async () => {
    // Runtime is the sole authority for task execution state. Do not rewrite task-state.json.
    const result = await callLocalMcpTool('task_control', {
      action: 'pause',
      reason: '用户从助手暂停',
    });
    const state = result?.state;
    if (!state) throw new Error('暂停请求已发出，但 Runtime 未返回任务状态。');
    return state;
  }));
  secureHandle('task-state:resume', () => invokeSafely(async () => {
    const result = await callLocalMcpTool('task_control', {
      action: 'resume',
      next_step: '用户从助手继续任务',
    });
    const state = result?.state;
    if (!state) throw new Error('继续请求已发出，但 Runtime 未返回任务状态。');
    return state;
  }));
  secureHandle('task-state:stop', () => invokeSafely(async () => {
    const result = await callLocalMcpTool('task_control', {
      action: 'stop',
      reason: '用户从助手停止任务',
      next_step: '确认后继续当前任务，或开始新任务。',
    });
    const state = result?.state;
    if (!state) throw new Error('停止请求已发出，但 Runtime 未返回任务状态。');
    if (result.stopped !== true) {
      throw new Error('Runtime 未能确认任务已停止。');
    }
    return state;
  }));
  secureHandle('task:read-console', (_event, options = {}) => invokeSafely(async () => {
    let runningCommand = null;
    let taskState = null;
    try {
      const { statePath } = workspaceStatePaths();
      taskState = readJson(statePath, null);
      if (taskState?.current_command && typeof taskState.current_command === 'object') {
        runningCommand = taskState.current_command;
      }
    } catch { /* ignore if no workspace */ }

    const logLines = [];
    let liveOutput = '';
    let liveStderr = '';
    let liveStatus = '';
    let liveExitCode = null;
    let consoleError = '';

    // 0. Prefer real process output via Runtime command_control when a session is live.
    if (runningCommand?.session_id) {
      try {
        const poll = await callLocalMcpTool('command_control', {
          action: 'poll',
          session_id: String(runningCommand.session_id),
          yield_time_ms: 50,
          max_output_bytes: 65536,
          verbosity: 'summary',
        });
        liveOutput = String(poll?.stdout || poll?.output || '');
        liveStderr = String(poll?.stderr || '');
        liveStatus = String(poll?.status || '');
        liveExitCode = poll?.exit_code ?? null;
        // Incremental cursor for next poll.
        if (poll?.output_ref) {
          runningCommand = { ...runningCommand, output_ref: poll.output_ref, offset: poll.offset ?? poll.byte_offset };
        }
      } catch (error) {
        consoleError = `无法读取活动命令输出：${safeMessage(error)}`;
      }
    } else if (runningCommand?.output_ref) {
      try {
        const readRes = await callLocalMcpTool('command_control', {
          action: 'read',
          output_ref: String(runningCommand.output_ref),
          offset: Number(runningCommand.offset || 0),
          limit: 65536,
        });
        liveOutput = String(readRes?.stdout || readRes?.content || '');
        liveStderr = String(readRes?.stderr || '');
        liveStatus = String(readRes?.status || '');
      } catch (error) {
        consoleError = `无法按游标补读输出：${safeMessage(error)}`;
      }
    }

    // 1. Synthesize user-facing activity logs from taskState events and commands
    if (taskState && Array.isArray(taskState.events) && taskState.events.length) {
      const formatTime = (iso) => {
        try {
          const d = new Date(iso);
          return isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8);
        } catch { return ''; }
      };

      for (const ev of taskState.events.slice(-80)) {
        const timeStr = formatTime(ev.time);
        const prefix = timeStr ? `[${timeStr}] ` : '';
        const d = ev.details || {};
        switch (ev.event) {
          case 'task_started':
            logLines.push(`${prefix}🚀 任务启动: ${taskState.objective || d.trigger_tool || '开始执行任务'}`);
            break;
          case 'files_modified':
            logLines.push(`${prefix}📝 文件变更: 影响 ${d.count || 1} 个文件`);
            break;
          case 'command_started':
            logLines.push(`${prefix}⚡ 启动命令: ${d.command || ''}`);
            break;
          case 'command_finished':
            logLines.push(`${prefix}${d.status === 'passed' ? '✔' : '❌'} 命令完成 (${d.status || 'done'}): ${d.command || ''} (耗时: ${d.elapsed_ms || 0}ms, 退出码: ${d.exit_code ?? 0})`);
            if (d.summary && typeof d.summary === 'string') {
              const summaryLines = d.summary.split(/\r?\n/).filter(Boolean).slice(0, 20);
              for (const sl of summaryLines) {
                logLines.push(`   │ ${sl}`);
              }
            }
            break;
          case 'command_terminated':
            logLines.push(`${prefix}⏹ 命令已终止: ${d.command || d.session_id || ''}`);
            break;
          case 'tool_failed':
            logLines.push(`${prefix}❌ 工具调用失败: ${d.name || d.tool || ''} - ${d.error?.message || d.failure || JSON.stringify(d)}`);
            break;
          case 'capsule_rollback':
            logLines.push(`${prefix}⏪ 时间胶囊已回滚: 还原 ${d.restored?.length || 0} 个文件，清理 ${d.removed?.length || 0} 个文件`);
            break;
          case 'build_verification_finished':
            logLines.push(`${prefix}🔍 构建验证完成: ${d.status || ''}`);
            break;
          default:
            logLines.push(`${prefix}ℹ [${ev.event}]: ${JSON.stringify(d)}`);
            break;
        }
      }
    }

    // 2. Live stdout/stderr (bounded)
    if (runningCommand) {
      logLines.push(`⚡ [当前运行中] ${runningCommand.command || ''}${liveStatus ? ` · ${liveStatus}` : ''}`);
      const outLines = String(liveOutput || runningCommand.output || '')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-80);
      for (const ol of outLines) logLines.push(`   │ ${ol}`);
      const errLines = String(liveStderr || '').split(/\r?\n/).filter(Boolean).slice(-20);
      if (errLines.length) {
        logLines.push('   │ --- stderr ---');
        for (const el of errLines) logLines.push(`   ! ${el}`);
      }
      if (consoleError) logLines.push(`   ! ${consoleError}`);
    }

    // 3. Read MCP runtime log file for background server notices, filtering routine HTTP ping noise
    // Bound file read: only tail last 256KB instead of whole file every poll.
    try {
      const targetLog = mcpLogFile();
      const stat = await fs.stat(targetLog);
      const maxBytes = 256 * 1024;
      const start = Math.max(0, stat.size - maxBytes);
      const handle = await fs.open(targetLog, 'r');
      try {
        const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
        await handle.read(buf, 0, buf.length, start);
        const content = buf.toString('utf8');
        const lines = content.split(/\r?\n/).filter(Boolean);
        const serverNotices = lines.filter((l) => !/POST \/mcp HTTP\/1\.1" 200 OK/i.test(l)).slice(-80);
        if (serverNotices.length) {
          if (logLines.length) logLines.push('--- [本地 MCP 运行时系统日志] ---');
          logLines.push(...serverNotices);
        }
      } finally {
        await handle.close();
      }
    } catch { /* ignore if log file not created yet */ }

    if (!logLines.length) {
      logLines.push('暂无控制台日志输出。当 ChatGPT 执行修改文件或运行命令时，实时输出将展示在此处。');
    }

    const modifiedFiles = Array.isArray(taskState?.modified_files) ? taskState.modified_files : [];

    return {
      runningCommand,
      status: taskState?.status || 'idle',
      objective: taskState?.objective || '',
      currentStep: taskState?.current_step || '',
      modifiedFiles,
      logs: logLines,
      live: {
        stdout: liveOutput.slice(-8000),
        stderr: liveStderr.slice(-4000),
        status: liveStatus,
        exit_code: liveExitCode,
        error: consoleError || '',
      },
    };
  }));
  secureHandle('workspace:open-in-explorer', (_event, targetPath) => invokeSafely(async () => {
    const current = settings.load();
    const root = path.resolve(String(current.workspace || '').trim());
    if (!root) throw new Error('当前未选择工作区。');
    const dest = targetPath ? assertPathInsideWorkspace(root, targetPath, '打开路径') : root;
    await shell.openPath(dest);
    return true;
  }));
  secureHandle('workspace:open-in-editor', (_event, targetPath) => invokeSafely(async () => {
    const current = settings.load();
    const root = path.resolve(String(current.workspace || '').trim());
    if (!root) throw new Error('当前未选择工作区。');
    const dest = targetPath ? assertPathInsideWorkspace(root, targetPath, '编辑路径') : root;
    try {
      await run('code.cmd', [dest], { timeoutMs: 5000 });
      return true;
    } catch {
      try {
        await run('code', [dest], { timeoutMs: 5000 });
        return true;
      } catch {
        await shell.openPath(dest);
        return false;
      }
    }
  }));
  secureHandle('workspace:show-in-folder', (_event, relativeOrAbsolute) => invokeSafely(async () => {
    const current = settings.load();
    const root = path.resolve(String(current.workspace || '').trim());
    if (!root) throw new Error('当前未选择工作区。');
    const full = assertPathInsideWorkspace(root, relativeOrAbsolute, '定位路径');
    shell.showItemInFolder(full);
    return true;
  }));
  secureHandle('task:kill-active-command', () => invokeSafely(async () => {
    let sessionId = '';
    let sessionSource = '';
    try {
      const { statePath } = workspaceStatePaths();
      const state = readJson(statePath, null);
      sessionId = String(state?.current_command?.session_id || '');
      if (sessionId) sessionSource = 'task-state';
    } catch { /* ignore missing workspace state */ }

    if (!sessionId) {
      // Fall back to Runtime task_control get() which owns the live command record.
      try {
        const runtimeState = await callLocalMcpTool('task_control', { action: 'get' });
        sessionId = String(runtimeState?.state?.current_command?.session_id || '');
        if (sessionId) sessionSource = 'runtime';
      } catch { /* ignore */ }
    }

    if (!sessionId) {
      throw new Error('未找到当前正在执行的命令 session_id，无法安全终止。请先确认控制台中确有运行中的命令。');
    }

    // command_control only supports poll/write/kill/read — never "terminate".
    const killResult = await callLocalMcpTool('command_control', {
      action: 'kill',
      session_id: sessionId,
      signal: 'TERM',
      wait_ms: 3000,
      kill_wait_ms: 2000,
    });

    const status = String(killResult?.status || '');
    const killed = killResult?.killed === true || status === 'exited' || status === 'killed' || status === 'terminated';
    if (!killed) {
      throw new Error(
        `命令 ${sessionId}（来源 ${sessionSource}）未能确认退出：status=${status || 'unknown'}。`
        + '请在控制台复查输出，必要时再次终止。'
      );
    }

    let taskResult = null;
    try {
      taskResult = await callLocalMcpTool('task_control', {
        action: 'stop',
        reason: '用户从控制台终止当前命令',
        next_step: '确认命令已退出后，决定继续任务或开始新任务。',
      });
    } catch (taskError) {
      throw new Error(
        `命令 ${sessionId} 已退出，但更新任务状态失败：${safeMessage(taskError)}。`
        + '请手动刷新任务状态，避免把未停止的任务显示为已停止。'
      );
    }

    return {
      ok: true,
      session_id: sessionId,
      session_source: sessionSource,
      command_status: status || killResult?.status,
      task_stopped: taskResult?.stopped === true,
      task: taskResult?.state || null,
    };
  }));
  secureHandle('task-state:history', () => invokeSafely(async () => {
    let historyPath;
    try { ({ historyPath } = workspaceStatePaths()); } catch { return []; }
    try { const value = JSON.parse(await fs.readFile(historyPath, 'utf8')); return Array.isArray(value) ? value.slice(-50).reverse() : []; }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  }));
  secureHandle('performance:read', () => invokeSafely(async () => {
    let performancePath;
    try { ({ performancePath } = workspaceStatePaths()); } catch { return null; }
    try { return JSON.parse(await fs.readFile(performancePath, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  }));
  secureHandle('performance:clear', () => invokeSafely(async () => {
    const { performancePath } = workspaceStatePaths();
    await fs.rm(performancePath, { force: true });
    return true;
  }));
  secureHandle('mcp:workspace-context', () => invokeSafely(() => callLocalMcpTool('workspace_context', { detail: 'compact', max_entries: 80 })));
  secureHandle('mcp:coding-tools-guide', (_event, options) => invokeSafely(() => callLocalMcpTool('coding_tools_guide', options || {})));
  secureHandle('mcp:task-runtime', (_event, options = {}) => invokeSafely(() => callLocalMcpTool('task_control', {
    action: 'get',
    detail: String(options?.detail || 'compact') === 'full' ? 'full' : 'compact'
  })));
  secureHandle('mcp:task-worktrees', () => invokeSafely(() => callLocalMcpTool('task_control', { action: 'worktree_list' })));
  secureHandle('mcp:task-worktree-diff', (_event, runId) => invokeSafely(() => callLocalMcpTool('task_control', { action: 'worktree_diff', run_id: String(runId || ''), max_bytes: 262144 })));
  secureHandle('mcp:task-worktree-apply', (_event, runId) => invokeSafely(() => callLocalMcpTool('task_control', { action: 'worktree_apply', run_id: String(runId || '') })));
  secureHandle('mcp:task-worktree-discard', (_event, runId) => invokeSafely(() => callLocalMcpTool('task_control', { action: 'worktree_discard', run_id: String(runId || '') })));
  secureHandle('notification:test', () => invokeSafely(() => taskNotificationService?.testNotification() ?? false));
  secureHandle('build:inspect', () => invokeSafely(() => buildVerification.inspect(settings.load().workspace)));
  secureHandle('build:run', (_event, options) => invokeSafely(() => buildVerification.execute(settings.load().workspace, options || {})));
  secureHandle('health:inspect', () => invokeSafely(() => healthService.inspect()));
  secureHandle('health:repair', () => invokeSafely(() => healthService.repair()));
  secureHandle('workspace:choose-and-switch', () => invokeSafely(async () => {
    const result = await dialog.showOpenDialog(chatWindow, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    const switched = await orchestrator.switchWorkspace(result.filePaths[0]);
    invalidateLocalMcpDiscovery();
    taskNotificationService?.reset();
    taskNotificationService?.restartStream();
    return switched;
  }));
  secureHandle('manager:close', () => invokeSafely(async () => {
    if (managerWindow && !managerWindow.isDestroyed()) managerWindow.hide();
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.show();
      chatWindow.focus();
    }
    return true;
  }));
  secureHandle('manager:open', () => invokeSafely(async () => { openManagerWindow(); return true; }));
  secureHandle('chat:navigate', (_event, action) => invokeSafely(async () => chatController?.navigate(action)));
  secureHandle('chat:status', () => invokeSafely(async () => chatController?.getState() || null));
  secureHandle('chat:inject-prompt', (_event, text, autoSend) => invokeSafely(async () => chatController?.injectPrompt(text, autoSend)));
  secureHandle('chat:set-content-insets', (_event, insets = {}) => invokeSafely(async () => {
    chatController?.setContentInsets({
      top: Number(insets.top) || 0,
      bottom: Number(insets.bottom) || 0
    });
    return true;
  }));
  secureHandle('chat:clear-session', () => invokeSafely(async () => {
    if (!chatController) throw new Error('ChatGPT 页面尚未初始化。');
    await chatController.clearSession();
    try {
      const { performancePath } = workspaceStatePaths();
      const raw = await fs.readFile(performancePath, 'utf8').catch(() => null);
      if (raw) contextUsageTracker.setSessionBaseline(JSON.parse(raw));
    } catch { /* ignore */ }
    contextUsageTracker.reset();
    return true;
  }));
  secureHandle('git:file-diff', (_event, relativePath) => invokeSafely(async () => {
    const { root } = workspaceStatePaths();
    const targetFile = String(relativePath || '').trim();
    if (!targetFile) throw new Error('未指定要对比的文件。');
    const fullPath = assertPathInsideWorkspace(root, targetFile, '对比文件路径');
    try {
      // 1. Try git diff HEAD
      const res = await run('git', ['diff', 'HEAD', '--', targetFile], { cwd: root, timeoutMs: 5000 });
      if (res.stdout.trim()) {
        return { isGit: true, diff: res.stdout.slice(0, 150000) };
      }
      // 2. If HEAD diff empty, try untracked file diff against null
      const statusRes = await run('git', ['status', '--porcelain', '--', targetFile], { cwd: root, timeoutMs: 3000 });
      if (statusRes.stdout.trim().startsWith('??')) {
        const content = await fs.readFile(fullPath, 'utf8').catch(() => '');
        const lines = content.split(/\r?\n/).slice(0, 300).map((l) => `+${l}`).join('\n');
        return { isGit: true, diff: `@@ 新增未跟踪文件: ${targetFile} @@\n${lines}` };
      }
      return { isGit: true, diff: '无内容变更（工作区与版本库一致）' };
    } catch {
      // Fallback if not a git repo: display current file preview
      try {
        const content = await fs.readFile(fullPath, 'utf8');
        const lines = content.split(/\r?\n/).slice(0, 300).map((l) => ` ${l}`).join('\n');
        return { isGit: false, diff: `@@ 本地文件内容预览（非 Git 仓库）@@\n${lines}` };
      } catch (err) {
        return { isGit: false, diff: `无法读取文件：${err.message}` };
      }
    }
  }));
  secureHandle('git:commit-and-push', (_event, options = {}) => invokeSafely(async () => {
    const { root, statePath } = workspaceStatePaths();
    const message = String(options.message || '').trim();
    if (!message) throw new Error('请输入提交信息（Commit Message）。');
    const doPush = Boolean(options.push);

    // Selective commit only. Never git add -A — long-lived work trees often
    // contain unrelated modifications that must not be swept into one commit.
    let files = Array.isArray(options.files)
      ? options.files.map((item) => String(typeof item === 'string' ? item : (item?.path || '')).trim()).filter(Boolean)
      : [];
    if (!files.length) {
      const state = readJson(statePath, null);
      files = Array.isArray(state?.modified_files)
        ? state.modified_files.map((item) => String(typeof item === 'string' ? item : (item?.path || '')).trim()).filter(Boolean)
        : [];
    }
    return await stageAndCommit(root, { message, files, push: doPush });
  }));
  secureHandle('task:generate-snapshot', (_event, options = {}) => invokeSafely(async () => {
    let taskState = null;
    let gitSummary = '';
    let root = '';
    try {
      const paths = workspaceStatePaths();
      root = paths.root;
      taskState = readJson(paths.statePath, null);
    } catch { /* ignore */ }

    if (root) {
      try {
        const statusRes = await run('git', ['status', '--short'], { cwd: root, timeoutMs: 3000 });
        gitSummary = statusRes.stdout.trim().slice(0, 800);
      } catch { /* not git */ }
    }

    // Persist handoff first so the next operator can verify, before any chat injection.
    let handoffPath = '';
    if (root && options?.writeFile !== false) {
      try {
        const handoff = await writeHandoffFile(root, {
          taskState,
          gitStatus: gitSummary,
          objective: taskState?.objective || '',
          currentStep: taskState?.current_step || taskState?.next_step || '',
          modifiedFiles: taskState?.modified_files || [],
          unverified: ['（未自动验证：请接手后确认测试/构建结果）'],
        });
        handoffPath = handoff.path;
      } catch { /* non-fatal for preview */ }
    }

    const extractPath = (item) => (typeof item === 'string' ? item : (item?.path || ''));
    const objective = taskState?.objective || '持续迭代代码工作区';
    const currentStep = taskState?.current_step || taskState?.next_step || '检查当前代码并推进下一步任务';
    const modified = Array.isArray(taskState?.modified_files) && taskState.modified_files.length
      ? taskState.modified_files
          .map((f) => {
            const p = extractPath(f);
            const op = (typeof f === 'object' && f?.operation) ? ` (${f.operation})` : '';
            return p ? `- \`${p}\`${op}` : null;
          })
          .filter(Boolean)
          .join('\n') || '（暂无已记录的修改文件）'
      : '（暂无已记录的修改文件）';
    const gitSection = gitSummary ? `\n\n**当前 Git 状态变更：**\n\`\`\`\n${gitSummary}\n\`\`\`` : '';
    const handoffSection = handoffPath ? `\n\n**交接文件已落盘：**\`${handoffPath}\`` : '';

    const snapshotMarkdown = [
      `【任务断点续接快照】`,
      `你好！这是从上一个对话继承过来的工作区任务状态（已写入交接文件，请先核对）：`,
      `- **核心任务目标**：${objective}`,
      `- **当前所处步骤**：${currentStep}`,
      `- **本次任务已修改文件**：\n${modified}${gitSection}${handoffSection}`,
      ``,
      `请先读取交接文件并核对当前代码状态，再继续下一步；不要假设测试/构建已经通过。`
    ].join('\n');

    return {
      snapshot: snapshotMarkdown,
      objective,
      handoffPath,
      modifiedFiles: (taskState?.modified_files || []).map(extractPath).filter(Boolean)
    };
  }));
  secureHandle('checkpoint:create', (_event, options = {}) => invokeSafely(async () => {
    const { root, statePath } = workspaceCapsulePaths();
    const taskState = readJson(statePath, null);
    const taskId = taskState?.task_id || `capsule_${Date.now()}`;
    const meta = await createSafeCheckpoint(root, {
      taskId,
      manual: Boolean(options.manual),
      description: options.description || '',
    });
    return meta;
  }));
  secureHandle('checkpoint:status', () => invokeSafely(async () => {
    try {
      const { root, statePath, capsuleMetaPath } = workspaceCapsulePaths();
      const meta = loadCheckpointMeta(capsuleMetaPath);
      const taskState = readJson(statePath, null);
      const modifiedFiles = Array.isArray(taskState?.modified_files) ? taskState.modified_files : [];
      return {
        hasCapsule: Boolean(meta),
        capsule: meta,
        modifiedCount: modifiedFiles.length,
        modifiedFiles: modifiedFiles.map((f) => typeof f === 'string' ? f : f?.path).filter(Boolean),
        canRollback: Boolean(meta) && meta.rollback_mode === 'three-way-baseline',
        rollbackMode: meta?.rollback_mode || null,
        rollbackDisabledReason: meta && meta.rollback_mode !== 'three-way-baseline'
          ? '旧格式检查点不支持安全回滚，请重新创建基线。'
          : null,
      };
    } catch {
      return {
        hasCapsule: false,
        capsule: null,
        modifiedCount: 0,
        modifiedFiles: [],
        canRollback: false,
        rollbackMode: null,
        rollbackDisabledReason: '未找到检查点。',
      };
    }
  }));
  secureHandle('checkpoint:rollback', (_event, options = {}) => invokeSafely(async () => {
    const { root, statePath, capsuleMetaPath } = workspaceCapsulePaths();
    const meta = loadCheckpointMeta(capsuleMetaPath);
    if (!meta) throw new Error('没有可用的安全检查点。请先创建任务前基线。');
    if (meta.rollback_mode !== 'three-way-baseline') {
      throw new Error('旧危险回滚已禁用。请重新创建安全基线（three-way-baseline）后再回滚。');
    }
    // One-shot approval binds rollback to this workspace + optional task.
    const approvalId = options?.approvalId ? String(options.approvalId) : '';
    if (approvalId) {
      const consumed = approvalStore.consume(approvalId, {
        action: 'checkpoint:rollback',
        scopeRoot: root,
      });
      if (!consumed.ok) throw new Error(consumed.error);
    } else if (options?.requireApproval !== false) {
      // Default path still executes but requires explicit confirm flag from UI.
      if (!options?.confirm) {
        throw new Error('安全回滚需要确认。请在界面上确认后再执行，或提供一次性 approvalId。');
      }
    }
    const taskState = readJson(statePath, null);
    const result = await rollbackSafeCheckpoint(root, meta, { taskState });
    if (taskState) {
      // Only clear modified_files on a fully successful rollback.
      if (result.success) {
        taskState.modified_files = [];
        taskState.events = Array.isArray(taskState.events) ? taskState.events : [];
        taskState.events.push({
          time: new Date().toISOString(),
          event: 'capsule_rollback',
          details: {
            restored: result.restoredFiles,
            removed: result.removedFiles,
            conflicts: result.conflicts,
            errors: result.errors,
            capsuleId: result.capsuleId,
            mode: 'three-way-baseline',
          },
        });
        taskState.updated_at = new Date().toISOString();
        writeJsonAtomic(statePath, taskState);
      } else {
        taskState.events = Array.isArray(taskState.events) ? taskState.events : [];
        taskState.events.push({
          time: new Date().toISOString(),
          event: 'capsule_rollback_partial',
          details: {
            restored: result.restoredFiles,
            removed: result.removedFiles,
            conflicts: result.conflicts,
            errors: result.errors,
            capsuleId: result.capsuleId,
          },
        });
        taskState.updated_at = new Date().toISOString();
        writeJsonAtomic(statePath, taskState);
      }
    }
    return result;
  }));
  secureHandle('approval:issue', (_event, payload = {}) => invokeSafely(async () => {
    let root = '';
    try { root = workspaceStatePaths().root; } catch { root = settings.load().workspace || ''; }
    const record = approvalStore.issue({
      action: String(payload.action || ''),
      scopeRoot: payload.scopeRoot || root,
      taskId: String(payload.taskId || ''),
      reason: String(payload.reason || ''),
    });
    return {
      id: record.id,
      action: record.action,
      expiresAt: new Date(record.expiresAt).toISOString(),
      scopeRoot: record.scopeRoot,
    };
  }));
  secureHandle('approval:consume', (_event, payload = {}) => invokeSafely(() => {
    let root = '';
    try { root = workspaceStatePaths().root; } catch { root = ''; }
    const result = approvalStore.consume(String(payload.id || ''), {
      action: String(payload.action || ''),
      scopeRoot: payload.scopeRoot || root,
      taskId: String(payload.taskId || ''),
    });
    if (!result.ok) throw new Error(result.error);
    return { used: true, action: result.record.action };
  }));
  secureHandle('task:write-handoff', (_event, options = {}) => invokeSafely(async () => {
    const { root, statePath } = workspaceStatePaths();
    const taskState = readJson(statePath, null);
    let gitStatus = '';
    let baselineHead = '';
    try {
      const statusRes = await run('git', ['status', '--short'], { cwd: root, timeoutMs: 3000 });
      gitStatus = statusRes.stdout.trim().slice(0, 8000);
      const headRes = await run('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 3000 });
      baselineHead = headRes.stdout.trim();
    } catch { /* not git */ }
    const written = await writeHandoffFile(root, {
      taskState,
      gitStatus,
      baselineHead,
      objective: options.objective || taskState?.objective || '',
      currentStep: options.currentStep || taskState?.current_step || taskState?.next_step || '',
      modifiedFiles: options.modifiedFiles || taskState?.modified_files || [],
      failedCommands: options.failedCommands || [],
      unverified: options.unverified || [],
      nextSteps: options.nextSteps || [],
      evidence: options.evidence || {
        status: taskState?.status || 'idle',
        failure: taskState?.failure || '',
        updated_at: taskState?.updated_at || '',
      },
    });
    return { path: written.path, bytes: written.bytes };
  }));
  secureHandle('dialog:workspace', () => invokeSafely(async () => {
    const result = await dialog.showOpenDialog(managerWindow || chatWindow, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? '' : result.filePaths[0];
  }));
  secureHandle('settings:save', (_event, patch) => invokeSafely(async () => {
    const allowed = ['permissionMode', 'toolMode', 'mcpPort', 'healthPort', 'proxyMode', 'proxyUrl', 'tunnelId', 'tunnelProfile', 'startWithWindows', 'autoStartServices', 'keepRunningOnClose', 'progressReportSeconds', 'taskNotifications', 'taskNotificationOnlyWhenUnfocused', 'taskNotificationSound', 'taskNotificationMinSeconds', 'theme', 'guideProgress', 'firstRunCompleted', 'bridgeRemovedNotice'];
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([key]) => allowed.includes(key)));
    const saved = settings.save(clean);
    if (Object.hasOwn(clean, 'startWithWindows')) {
      app.setLoginItemSettings({ openAtLogin: Boolean(saved.startWithWindows), path: process.execPath });
    }
    if (Object.hasOwn(clean, 'mcpPort')) taskNotificationService?.restartStream();
    if (Object.hasOwn(clean, 'theme') && chatWindow && !chatWindow.isDestroyed()) {
      const nextTheme = saved.theme === 'light' ? 'light' : 'dark';
      chatWindow.webContents.send('theme:changed', nextTheme);
      chatWindow.setBackgroundColor(nextTheme === 'dark' ? '#000000' : '#f7f7f8');
    }
    clearProxyCache();
    return saved;
  }));
  secureHandle('environment:detect-proxy', () => invokeSafely(async () => resolveProxy(settings.load(), { force: true })));
  secureHandle('secrets:runtime-key', (_event, value) => invokeSafely(async () => {
    if (String(value || '').trim().length < 12) throw new Error('Runtime API Key 长度不正确。');
    secrets.set('runtimeApiKey', value);
    return secrets.status();
  }));
  secureHandle('secrets:runtime-key-remove', () => invokeSafely(async () => {
    secrets.remove('runtimeApiKey');
    return secrets.status();
  }));
  secureHandle('secrets:mcp-token-regenerate', () => invokeSafely(async () => {
    secrets.set('mcpAuthToken', crypto.randomBytes(32).toString('base64url'));
    return secrets.status();
  }));
  secureHandle('runtime:start', () => invokeSafely(async () => { const result = await orchestrator.start(); invalidateLocalMcpDiscovery(); return result; }));
  secureHandle('runtime:stop', () => invokeSafely(async () => { const result = await orchestrator.stop(); invalidateLocalMcpDiscovery(); return result; }));
  secureHandle('runtime:restart', () => invokeSafely(async () => { const result = await orchestrator.restart(); invalidateLocalMcpDiscovery(); return result; }));
  secureHandle('logs:read', () => invokeSafely(async () => log.read()));
  secureHandle('logs:clear', () => invokeSafely(async () => { log.clear(); return true; }));
  secureHandle('environment:install-python', () => invokeSafely(async () => {
    const result = await run('winget.exe', ['install', '--id', 'Python.Python.3.12', '-e', '--accept-source-agreements', '--accept-package-agreements']);
    return result.stdout;
  }));
  secureHandle('context:usage', () => invokeSafely(async () => {
    try {
      const { performancePath } = workspaceStatePaths();
      const raw = await fs.readFile(performancePath, 'utf8');
      const trace = JSON.parse(raw);
      contextUsageTracker.syncWithRuntime(trace);
    } catch { /* if no workspace or performance file yet, keep snapshot */ }
    return contextUsageTracker.snapshot();
  }));
  secureHandle('context:reset-usage', () => invokeSafely(async () => {
    try {
      const { performancePath } = workspaceStatePaths();
      await fs.rm(performancePath, { force: true });
    } catch { /* ignore if not exist */ }
    contextUsageTracker.setSessionBaseline(null);
    return contextUsageTracker.reset();
  }));
  secureHandle('shell:open', (_event, target) => invokeSafely(async () => {
    const allowed = new Set(['chatgpt-connectors', 'openai-tunnels', 'openai-runtime-keys', 'tunnel-ui', 'coding-tools-source']);
    if (!allowed.has(target)) throw new Error('不允许打开该地址。');
    if (target === 'chatgpt-connectors' && chatController) {
      await chatController.openUrl('https://chatgpt.com/#settings/Connectors');
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.show();
        chatWindow.focus();
      }
      return true;
    }
    const current = settings.load();
    const urls = {
      'chatgpt-connectors': 'https://chatgpt.com/#settings/Connectors',
      'openai-tunnels': 'https://platform.openai.com/settings/organization/tunnels',
      'openai-runtime-keys': 'https://platform.openai.com/settings/organization/api-keys',
      'tunnel-ui': `http://127.0.0.1:${current.healthPort}/ui`,
      'coding-tools-source': 'https://github.com/xyTom/coding-tools-mcp'
    };
    await shell.openExternal(urls[target]);
    return true;
  }));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showChatWindow());

  app.whenReady().then(async () => {
    app.setLoginItemSettings({ openAtLogin: Boolean(settings.load().startWithWindows), path: process.execPath });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    app.on('web-contents-created', (_event, contents) => {
      contents.on('will-attach-webview', (event) => event.preventDefault());
    });
    createTray();
    orchestrator = new RuntimeOrchestrator({
      settings,
      secrets,
      environment,
      log,
      emitProgress: (payload) => sendManager('runtime:progress', payload),
      emitStatus: (payload) => {
        updateTrayTooltip(payload?.snapshot?.status);
        sendManager('runtime:status-changed', payload);
      }
    });
    buildVerification = new BuildVerificationService(log, (payload) => sendManager('build:progress', payload));
    healthService = new HealthService({ settings, secrets, environment, orchestrator });
    log.on('entry', (payload) => sendManager('logs:entry', payload));
    registerIpc();
    const startupSettings = settings.load();
    createChatWindow();
    taskNotificationService = new TaskNotificationService({
      getSettings: () => settings.load(),
      getWorkspace: () => settings.load().workspace,
      loadNotificationCheckpoint: (workspace) => notificationCheckpoints.load(workspace),
      saveNotificationCheckpoint: (workspace, checkpoint) => notificationCheckpoints.save(workspace, checkpoint),
      readTaskState: () => {
        try { return readJson(workspaceStatePaths().statePath, null); }
        catch { return null; }
      },
      subscribeTaskEvents: (listener, onError, streamOptions = {}) => {
        const current = settings.load();
        const token = secrets.get('mcpAuthToken');
        const client = new LocalMcpClient({ port: current.mcpPort, token, log });
        return client.subscribeTaskEvents(listener, { onError, ...streamOptions });
      },
      getChatWindow: () => chatWindow,
      getTray: () => tray,
      showChatWindow,
      NotificationClass: Notification,
      icon: appIconPath(),
      log
    });
    taskNotificationService.start();
    contextUsageTracker.on('change', (snapshot) => {
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.webContents.send('context:usage-changed', snapshot);
      }
    });
    superviseTimer = null;
    const scheduleSupervise = (delayMs = 5000) => {
      if (superviseTimer) clearTimeout(superviseTimer);
      superviseTimer = setTimeout(() => {
        orchestrator.supervise().then((status) => {
          taskNotificationService?.acceptRuntimeStatus?.(status);
          updateTrayTooltip(status);
          sendManager('runtime:heartbeat', status);
          if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('runtime:heartbeat', status);
          try {
            const { performancePath } = workspaceStatePaths();
            fs.readFile(performancePath, 'utf8').then((raw) => {
              contextUsageTracker.syncWithRuntime(JSON.parse(raw));
            }).catch(() => {});
          } catch { /* ignore if no workspace */ }
        }).catch(() => {}).finally(() => {
          const isForeground = Boolean(
            (chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible() && !chatWindow.isMinimized())
            || (managerWindow && !managerWindow.isDestroyed() && managerWindow.isVisible())
          );
          const nextDelay = isForeground ? 5000 : 15000;
          scheduleSupervise(nextDelay);
        });
      }, delayMs);
      superviseTimer.unref?.();
    };
    scheduleSupervise(5000);
    log.info('网页 MCP 助手已启动');
    if (startupSettings.autoStartServices && !orchestrator.isManuallyStopped()) {
      orchestrator.start({ automatic: true }).catch((error) => log.error(error.message, { stage: 'auto-start' }));
    }
  });

  app.on('before-quit', () => {
    forceQuit = true;
    if (superviseTimer) clearTimeout(superviseTimer);
    taskNotificationService?.stop();
  });
  app.on('window-all-closed', () => {
    if (!forceQuit && settings.load().keepRunningOnClose) return;
    if (!forceQuit) app.quit();
  });
  app.on('activate', () => showChatWindow());
}






