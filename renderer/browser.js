const api = window.browserAssistant;
const $ = (selector) => document.querySelector(selector);
let switching = false;
let activeWorkspace = '';
let lastRuntimeState = null;
let lastRuntimeCheckAt = 0;
let workspaceHubState = { workspaces: [] };
let lastApprovalRequestId = '';
let lastStreamState = { status: 'unknown', updatedAt: 0 };
let progressInput = { task: null, operation: null, activity: null, runtimeLayers: null, feedbackCapabilities: null, available: true, stale: false };
let taskRefreshPromise = null;
let lastTaskRefreshAt = 0;
let taskRefreshWarning = '';
let nativeLoginState = { status: 'idle', message: '' };
let loginState = { status: 'idle', mode: '', prompt: false };
let activityPopoverPinned = false;
let activityDetailVisible = false;
let activityOpenTimer = null;
let activityCloseTimer = null;
let currentConversationKey = '';
let currentChatSchemaIdentity = '';
let dismissedSchemaMismatch = '';

function syncToolbarDensity(view, forceExpanded = false) {
  const expandedStates = new Set(['local_running', 'testing', 'building', 'planning', 'recovering', 'quiet', 'suspected_stall', 'stalled', 'failed', 'waiting_user', 'generating']);
  const expanded = forceExpanded || expandedStates.has(String(view?.userState || view?.key || ''));
  $('#progressBand')?.classList.toggle('compact', !expanded);
}

function schemaIdentityKey(identity = {}) {
  const version = String(identity.version || '');
  const schemaVersion = Number(identity.schemaVersion || identity.schema_version || 0);
  const schemaHash = String(identity.schemaHash || identity.schema_hash || '');
  const toolCount = Number(identity.toolCount || identity.tool_count || 0);
  return schemaVersion && schemaHash ? `${version}|${schemaVersion}|${schemaHash}|${toolCount}` : '';
}

function chatConversationKey(url) {
  try {
    const parsed = new URL(String(url || ''));
    const match = parsed.pathname.match(/\/c\/([^/]+)/i);
    return match ? `c:${match[1]}` : 'new';
  } catch { return 'new'; }
}

function storedChatSchemaIdentity(key) {
  try { return String(localStorage.getItem(`mcp-chat-schema:${key}`) || ''); }
  catch { return ''; }
}

function rememberChatSchemaIdentity(key, identity) {
  if (!key || !identity) return;
  currentChatSchemaIdentity = identity;
  try { localStorage.setItem(`mcp-chat-schema:${key}`, identity); } catch {}
}

function refreshSchemaHint() {
  const hint = $('#schemaRefreshHint');
  if (!hint) return;
  const runtimeIdentity = schemaIdentityKey(lastRuntimeState?.schemaIdentity || {});
  const mismatchKey = currentChatSchemaIdentity && runtimeIdentity && currentChatSchemaIdentity !== runtimeIdentity
    ? `${currentConversationKey}|${currentChatSchemaIdentity}|${runtimeIdentity}`
    : '';
  hint.hidden = !mismatchKey || dismissedSchemaMismatch === mismatchKey;
  hint.dataset.mismatchKey = mismatchKey;
  hint.title = mismatchKey
    ? '当前聊天仍绑定升级前的工具定义。新建聊天后会自动使用最新版工具参数。点击可暂时关闭此提示。'
    : '';
}

function withTimeout(promise, timeoutMs, label = '请求') {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时`)), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

function setSwitchState(message = '', tone = 'success', clearAfterMs = 0) {
  const node = $('#switchState');
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('error', tone === 'error');
  if (clearAfterMs > 0) setTimeout(() => {
    if (node.textContent === message) { node.textContent = ''; node.classList.remove('error'); }
  }, clearAfterMs);
}

function unwrap(result) {
  if (!result?.ok) throw new Error(result?.error || '操作失败');
  return result.data;
}

function baseName(value) {
  return String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value || '未选择';
}

function taskPresentation(task, runningOperation, streamState, available = true, activity = null, runtimeLayers = null) {
  const view = window.assistantState.describe(task, runningOperation, streamState, Date.now(), available, activity, !available, runtimeLayers);
  return { key: view.key, tone: window.assistantState.toneFor(view), label: window.assistantState.labelFor(view), detail: view.message, canStop: Boolean(view.canStop) };
}

function formatActivityTime(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
}

function formatActivityDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function formatActivityAge(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 3) return '刚刚';
  if (value < 60) return `${Math.floor(value)} 秒前`;
  const minutes = Math.floor(value / 60);
  const rest = Math.floor(value % 60);
  return minutes < 60 ? `${minutes} 分${rest ? ` ${rest} 秒` : ''}前` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分前`;
}

function localizeActivityText(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const exact = { 'Waiting for model': '等待 ChatGPT', 'Command started': '命令已启动', 'Command completed': '命令已完成', running: '运行中', completed: '已完成', failed: '失败', exited: '已结束', queued: '排队中', cancelled: '已取消' };
  if (exact[text]) return exact[text];
  return text.replace(/Waiting for model/gi, '等待 ChatGPT').replace(/\bexited\b/gi, '已结束').replace(/\brunning\b/gi, '运行中').replace(/\bcompleted\b/gi, '已完成').replace(/\bfailed\b/gi, '失败').replace(/\bexit\s+(-?\d+)/gi, '退出码 $1');
}

function meaningfulTimeline(items) {
  const noisy = /waiting[_ -]?model|等待\s*ChatGPT|heartbeat|心跳/i;
  const result = [];
  for (const event of Array.isArray(items) ? items : []) {
    const type = String(event?.type || '').trim();
    const label = localizeActivityText(event?.label || type || event?.event || '');
    const detail = localizeActivityText(event?.detail || event?.step || '');
    if (!label || noisy.test(`${type} ${label} ${detail}`)) continue;
    const item = { label, detail, time: formatActivityTime(event?.timestamp) };
    const previous = result.at(-1);
    if (previous && previous.label === item.label && previous.detail === item.detail) continue;
    result.push(item);
  }
  return result.slice(-8).reverse();
}

function clearActivityTimers() {
  if (activityOpenTimer) clearTimeout(activityOpenTimer);
  if (activityCloseTimer) clearTimeout(activityCloseTimer);
  activityOpenTimer = null;
  activityCloseTimer = null;
}

function activityAnchorPayload(anchor) {
  const rect = (anchor || $('#progressDetailTrigger')).getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
}

function openActivityPanel(anchor, { pin = false } = {}) {
  if ($('#activityToggle')?.hidden) return;
  clearActivityTimers();
  if (pin) activityPopoverPinned = true;
  activityDetailVisible = true;
  void api.activityDetailShow?.({
    anchor: activityAnchorPayload(anchor),
    pinned: activityPopoverPinned,
    payload: buildActivityDetailPayload()
  });
  $('#activityToggle')?.setAttribute('aria-expanded', 'true');
  $('#progressDetailTrigger')?.setAttribute('aria-expanded', 'true');
  if ($('#activityToggle')) $('#activityToggle').textContent = activityPopoverPinned ? '收起详情' : '活动详情';
}

function closeActivityPanel({ force = false } = {}) {
  if (activityPopoverPinned && !force) return;
  clearActivityTimers();
  if (force) {
    activityPopoverPinned = false;
    activityDetailVisible = false;
    void api.activityDetailClose?.();
    $('#activityToggle')?.setAttribute('aria-expanded', 'false');
    $('#progressDetailTrigger')?.setAttribute('aria-expanded', 'false');
  } else {
    void api.activityDetailHide?.();
  }
}

function scheduleActivityOpen(anchor) {
  if ($('#activityToggle')?.hidden) return;
  if (activityCloseTimer) clearTimeout(activityCloseTimer);
  activityOpenTimer = setTimeout(() => openActivityPanel(anchor), 150);
}

function scheduleActivityClose() {
  if (activityPopoverPinned) return;
  if (activityOpenTimer) clearTimeout(activityOpenTimer);
  activityCloseTimer = setTimeout(() => closeActivityPanel(), 180);
}

function buildActivityDetailPayload() {
  const { task, operation, activity, runtimeLayers, feedbackCapabilities, available, stale } = progressInput;
  const command = activity?.command && typeof activity.command === 'object'
    ? activity.command
    : (task?.current_command && typeof task.current_command === 'object' ? task.current_command : null);
  const lastCommand = task?.last_command && typeof task.last_command === 'object' ? task.last_command : null;
  const timeline = Array.isArray(activity?.timeline) ? activity.timeline : [];
  const view = window.progressPresentation.describe(task, operation, lastStreamState, Date.now(), available, activity, stale, runtimeLayers);
  const stateLabel = {
    testing: '正在测试', building: '正在构建', waiting_model: '等待 ChatGPT', waiting_user: '等待处理', quiet: '仍在运行',
    suspected_stall: '疑似停滞', stalled: '疑似卡住', local_running: '本地运行中', planning: '正在规划', recovering: '正在恢复',
    completed: '已完成', failed: '失败', stopped: '已停止', generating: '模型处理中'
  }[view.userState || view.key] || view.key || '—';
  const commandRunning = command?.status === 'running'
    || command?.execution_lifecycle_state === 'running'
    || runtimeLayers?.process?.state === 'running'
    || runtimeLayers?.execution?.state === 'running';
  const stage = commandRunning
    ? '正在执行本地命令'
    : localizeActivityText(task?.current_step || operation?.phase || operation?.status || (task?.status === 'completed' ? '本地任务已完成' : ''));
  const lastActivityAt = command?.last_output_at || lastCommand?.finished_at || timeline.at(-1)?.timestamp || task?.updated_at || operation?.updated_at;
  let waitReason = '—';
  const lifecycle = String(task?.lifecycle_state || '');
  if (!available) waitReason = '等待本地状态连接恢复';
  else if (commandRunning) waitReason = command?.last_output_at ? '等待命令继续输出或结束' : '命令已启动，等待首段输出';
  else if (lifecycle === 'waiting_model') waitReason = '等待 ChatGPT 发起下一次工具调用';
  else if (operation && ['running', 'queued'].includes(String(operation.status || ''))) waitReason = operation.status === 'queued' ? '等待后台执行槽位' : '等待后台阶段完成';
  else if (lastStreamState.status === 'generating') waitReason = '等待网页端发起本地工具调用';
  const nativeStatus = feedbackCapabilities?.chatgpt_tool_invocation_status?.supported;
  const desktopStream = feedbackCapabilities?.desktop_activity_stream?.supported;
  const lastResultStatus = lastCommand?.status || task?.latest_test_result?.status || task?.latest_build_result?.status || '';
  const lastExitCode = lastCommand?.exit_code;
  const lastResult = lastResultStatus
    ? `${localizeActivityText(lastResultStatus)}${lastExitCode == null ? '' : ` · 退出码 ${lastExitCode}`}${lastCommand?.elapsed_ms == null ? '' : ` · ${formatActivityDuration(lastCommand.elapsed_ms)}`}`
    : '';
  const output = String(command?.latest_output || '').trim();
  const operationRunning = operation && ['running', 'queued'].includes(String(operation.status || ''));
  const showHeartbeat = Boolean(commandRunning || operationRunning);
  return {
    status: view.message,
    capturedAt: `${stale ? '最后成功读取 ' : '状态读取 '}${formatActivityTime(activity?.captured_at || task?.updated_at)}`,
    state: stateLabel,
    stage,
    elapsed: commandRunning || operationRunning ? (view.elapsed || formatActivityDuration(command?.elapsed_ms)) : '',
    lastSeen: lastActivityAt ? formatActivityTime(lastActivityAt) : '',
    process: runtimeLayers?.process?.state === 'running' ? '本地进程运行中' : runtimeLayers?.process?.state === 'background' ? '后台任务运行中' : '',
    waitReason,
    nextStep: task?.next_step || (view.userState === 'waiting_model' ? '等待 ChatGPT 继续' : '—'),
    channel: nativeStatus && desktopStream ? 'ChatGPT 调用提示 + 桌面实时状态' : desktopStream ? '桌面实时状态' : '任务状态快照',
    taskId: task?.task_id || '',
    runId: task?.run_id || operation?.run_id || '',
    operationId: operation?.operation_id || '',
    lastResult,
    diagnosis: view.diagnostic || (view.userState === 'waiting_model' ? '本地执行已经结束，目前在等待 ChatGPT 继续。' : '当前没有发现异常。'),
    command: command?.command || '',
    output,
    outputMeta: commandRunning ? '实时更新' : '',
    timeline: meaningfulTimeline(timeline)
  };
}

function renderActivityPanel() {
  const toggle = $('#activityToggle');
  if (!toggle) return;
  const { task, operation, activity, runtimeLayers } = progressInput;
  const command = activity?.command || task?.current_command;
  const hasContent = Boolean(task || operation || command || (Array.isArray(activity?.timeline) && activity.timeline.length) || runtimeLayers);
  toggle.hidden = !hasContent;
  if (!hasContent) {
    activityPopoverPinned = false;
    activityDetailVisible = false;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '活动详情';
    void api.activityDetailClose?.();
    return;
  }
  const view = window.progressPresentation.describe(progressInput.task, progressInput.operation, lastStreamState, Date.now(), progressInput.available, progressInput.activity, progressInput.stale, progressInput.runtimeLayers);
  if (!activityDetailVisible) toggle.textContent = ['quiet', 'suspected_stall', 'stalled'].includes(view.userState) ? '为什么看起来卡住了？' : '活动详情';
  if (activityDetailVisible) void api.activityDetailUpdate?.(buildActivityDetailPayload());
}

function renderChatState(state) {
  if (!state) return;
  const nextConversationKey = chatConversationKey(state.url);
  if (nextConversationKey !== currentConversationKey) {
    const previousIdentity = currentChatSchemaIdentity;
    const previousKey = currentConversationKey;
    currentConversationKey = nextConversationKey;
    currentChatSchemaIdentity = storedChatSchemaIdentity(nextConversationKey);
    if (!currentChatSchemaIdentity && previousKey === 'new' && nextConversationKey.startsWith('c:') && previousIdentity) {
      rememberChatSchemaIdentity(nextConversationKey, previousIdentity);
    }
    dismissedSchemaMismatch = '';
  }
  const attachmentReady = ['attached', 'available'].includes(String(state.mcpAttachment?.status || ''));
  const runtimeIdentity = schemaIdentityKey(lastRuntimeState?.schemaIdentity || {});
  if (attachmentReady && !currentChatSchemaIdentity && runtimeIdentity) {
    rememberChatSchemaIdentity(currentConversationKey || nextConversationKey, runtimeIdentity);
  }
  refreshSchemaHint();
  lastStreamState = state.streamState || lastStreamState;
  nativeLoginState = state.nativeLogin || nativeLoginState;
  loginState = state.login || loginState;
  renderLogin();
  renderProgress();
  $('#backButton').disabled = !state.canGoBack;
  $('#forwardButton').disabled = !state.canGoForward;
  const element = $('#pageState');
  element.classList.toggle('loading', Boolean(state.loading));
  element.classList.toggle('ready', !state.loading && !state.error);
  element.classList.toggle('error', Boolean(state.error));
  element.querySelector('span').textContent = state.error
    ? `加载失败：${state.error}`
    : state.url?.startsWith('https://accounts.google.com/') ? 'Google 登录请使用右侧「登录修复」'
    : state.loading ? '正在切换页面…' : 'ChatGPT 已就绪';
}

function renderProgress() {
  renderActivityPanel();
  const login = nativeLoginState;
  const activeLogin = login.active || ['starting', 'waiting', 'syncing', 'closing'].includes(login.status);
  $('#nativeLoginButton').disabled = ['starting', 'syncing', 'closing'].includes(login.status);
  $('#nativeLoginFinish').hidden = !['waiting', 'syncing'].includes(login.status);
  $('#nativeLoginFinish').disabled = login.status === 'syncing';
  $('#nativeLoginCancel').hidden = !activeLogin;
  $('#nativeLoginCancel').disabled = login.status === 'closing';
  if (activeLogin || ['error', 'success'].includes(login.status)) {
    syncToolbarDensity(null, true);
    $('#progressBand').className = `progress-band ${login.status === 'error' ? 'failed' : login.status === 'success' ? 'active' : 'waiting'}`;
    $('#progressMessage').textContent = login.status === 'success' ? 'ChatGPT 登录修复完成' : login.status === 'error' ? '登录修复未完成' : '浏览器登录修复';
    $('#progressDetail').textContent = login.cleanupWarning || login.message;
    $('#progressDetail').title = `${login.message}${login.cleanupWarning ? ` ${login.cleanupWarning}` : ''}`;
    $('#progressElapsed').textContent = '';
    $('#progressAction').hidden = true;
    return;
  }
  if (loginState.mode === 'embedded' && !loginState.prompt) {
    syncToolbarDensity(null, true);
    $('#progressBand').className = 'progress-band waiting';
    $('#progressMessage').textContent = loginState.returning ? '登录已确认，正在自动返回' : '正在应用内登录 ChatGPT';
    $('#progressDetail').textContent = loginState.message;
    $('#progressElapsed').textContent = '';
    $('#progressAction').hidden = true;
    return;
  }
  const view = window.progressPresentation.describe(
    progressInput.task,
    progressInput.operation,
    lastStreamState,
    Date.now(),
    progressInput.available,
    progressInput.activity,
    progressInput.stale,
    progressInput.runtimeLayers
  );
  const band = $('#progressBand');
  band.className = `progress-band ${view.key} tone-${window.assistantState.toneFor(view)}`;
  syncToolbarDensity(view);
  $('#progressMessage').textContent = view.message;
  $('#progressDetail').textContent = view.detail;
  $('#progressElapsed').textContent = view.elapsed ? `已运行 ${view.elapsed}` : '';
  const action = $('#progressAction');
  if (action) {
    action.hidden = !view.action;
    action.textContent = view.actionLabel || '';
    action.dataset.action = view.action || '';
    action.title = view.actionLabel || '';
  }
}

function renderServiceState(state) {
  lastRuntimeState = state || null;
  lastRuntimeCheckAt = Date.now();
  const connectionRunning = state?.tunnelRunning;
  refreshSchemaHint();
  const label = $('#connectionStateLabel');
  if (label) label.textContent = '连接通道';
  [['#mcpState', state?.mcpRunning], ['#tunnelState', connectionRunning]].forEach(([selector, value]) => {
    const element = $(selector);
    element.classList.toggle('ready', Boolean(value));
    element.classList.toggle('error', !value);
  });
  renderWorkspaceHealth();
}

function renderWorkspaceHealth() {
  const button = $('#workspaceHealthButton');
  if (!button) return;
  const synced = Boolean(activeWorkspace && lastRuntimeState?.mcpRunning);
  button.classList.toggle('ready', synced);
  button.classList.toggle('error', Boolean(activeWorkspace) && !synced);
  $('#workspaceHealthName').textContent = baseName(activeWorkspace) || '未选择工作区';
  $('#workspaceHealthPath').textContent = activeWorkspace || '-';
  $('#workspaceHealthState').textContent = !activeWorkspace ? '未选择' : synced ? '✓ 已同步' : lastRuntimeState?.recovering ? '正在恢复' : '等待同步';
  $('#workspaceHealthTime').textContent = lastRuntimeCheckAt ? new Date(lastRuntimeCheckAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
  button.title = !activeWorkspace ? '未选择工作区' : synced ? '工作区已与 MCP 同步' : '工作区正在等待 MCP 同步';
}

async function refreshStatus() {
  try { renderServiceState(unwrap(await withTimeout(api.lightweightStatus(), 2500, '连接状态读取'))); }
  catch { renderServiceState(null); }
}

async function refreshTask() {
  const strip = $('#taskStrip');
  if (!strip) return;
  if (taskRefreshPromise) return taskRefreshPromise;
  taskRefreshPromise = (async () => {
  try {
    let runtime = null;
    try { runtime = unwrap(await withTimeout(api.taskRuntime({ detail: 'compact' }), 2800, '任务状态读取')); } catch { runtime = null; }
    let task = runtime?.state || null;
    if (!task) {
      try { task = unwrap(await withTimeout(api.taskState(), 1600, '任务状态兜底读取'))?.state || null; } catch { task = null; }
    }
    void refreshLocalTaskTools(task);
    const runningOperation = Array.isArray(runtime?.operations)
      ? runtime.operations.filter((item) => ['running', 'queued'].includes(String(item?.status || ''))).slice(-1)[0]
      : null;
    if (task && ['completed', 'failed', 'stopped'].includes(String(task.status || '')) && !runningOperation) {
      const updatedAt = Date.parse(task.updated_at || task.created_at || '') || Date.now();
      const keepVisibleMs = task.status === 'completed' ? 30000 : 120000;
      const newerChatTurn = lastStreamState.status === 'generating' && Number(lastStreamState.updatedAt || 0) > updatedAt;
      if (newerChatTurn || Date.now() - updatedAt > keepVisibleMs) task = null;
    }
    const stateAvailable = Boolean(runtime || task);
    if (stateAvailable) {
      progressInput = {
        task,
        operation: runningOperation,
        activity: runtime?.activity || progressInput.activity,
        runtimeLayers: runtime?.runtime_layers || progressInput.runtimeLayers,
        feedbackCapabilities: runtime?.feedback_capabilities || progressInput.feedbackCapabilities,
        available: true,
        stale: !runtime
      };
    } else {
      progressInput = { ...progressInput, available: false, stale: true };
    }
    lastTaskRefreshAt = Date.now();
    taskRefreshWarning = stateAvailable ? '' : '暂时无法确认本地任务状态，已保留最后一次结果并自动重试';
    renderProgress();
    const view = taskPresentation(progressInput.task, progressInput.operation, lastStreamState, progressInput.available, progressInput.activity, progressInput.runtimeLayers);
    strip.className = `task-strip ${view.key} tone-${view.tone}`;
    $('#taskStatusLabel').textContent = view.label;
    $('#taskTitle').textContent = view.detail;
    $('#stopTask').hidden = !view.canStop;
  } catch {
    taskRefreshWarning = '任务状态读取失败，正在自动重试';
    progressInput = { ...progressInput, available: false, stale: true };
    renderProgress();
    const view = taskPresentation(progressInput.task, progressInput.operation, lastStreamState, false, progressInput.activity);
    strip.className = `task-strip ${view.key} tone-${view.tone}`;
    $('#taskStatusLabel').textContent = view.label;
    $('#taskTitle').textContent = view.detail;
    $('#stopTask').hidden = true;
  }
  if (nativeLoginState.status === 'idle' && loginState.mode !== 'embedded' && taskRefreshWarning && !progressInput.task && !progressInput.operation) {
    $('#progressDetail').textContent = taskRefreshWarning;
  }
  })();
  try { return await taskRefreshPromise; } finally { taskRefreshPromise = null; }
}

async function refreshApprovals() {
  if (!api.approvalList || !api.openApprovalWindow) return;
  try {
    const payload = unwrap(await api.approvalList());
    const pending = Array.isArray(payload?.pending) ? payload.pending : [];
    const newest = pending[0]?.request_id || '';
    if (!newest) {
      lastApprovalRequestId = '';
      return;
    }
    if (newest === lastApprovalRequestId) return;
    lastApprovalRequestId = newest;
    await api.openApprovalWindow();
  } catch { /* approval polling must never disturb ChatGPT */ }
}

function renderWorkspace(hub) {
  workspaceHubState = hub || { workspaces: [] };
  activeWorkspace = hub.activeWorkspace || '';
  $('#activeWorkspace').textContent = activeWorkspace || '未选择';
  $('#activeWorkspace').title = activeWorkspace;
  renderWorkspaceHealth();
  const workspaces = Array.isArray(hub.workspaces)
    ? hub.workspaces
    : (hub.recentWorkspaces || []).filter(Boolean).map((workspace) => ({ path: workspace, name: baseName(workspace), active: workspace === activeWorkspace, status: 'ready' }));
  $('#workspacePickerButton').textContent = `全部工作区（${workspaces.length}）${Number(hub.invalidCount || 0) ? ` · ⚠ ${hub.invalidCount}` : ''}`;
}

async function refreshWorkspace() {
  try { renderWorkspace(unwrap(await api.workspaceHub())); }
  catch { /* retain the last usable workspace state */ }
}

async function switchWorkspace(workspace, showProgress = true) {
  if (switching || !workspace || workspace === activeWorkspace) return;
  switching = true;
  if (showProgress) setSwitchState('正在切换工作区…');
  try {
    unwrap(await api.switchWorkspace(workspace));
    setSwitchState('工作区已就绪', 'success', 1600);
    await Promise.all([refreshWorkspace(), refreshStatus(), refreshTask()]);
  } catch (error) {
    setSwitchState(`切换失败：${error.message}`, 'error');
  } finally {
    switching = false;
  }
}

async function navigate(action) {
  try { unwrap(await api.navigate(action)); }
  catch (error) { renderChatState({ error: error.message }); }
}

$('#backButton').onclick = () => navigate('back');
$('#forwardButton').onclick = () => navigate('forward');
$('#reloadButton').onclick = () => navigate('reload');
$('#homeButton').onclick = () => navigate('home');
async function runNativeLogin(method) {
  try { nativeLoginState = unwrap(await api[method]()); }
  catch (error) { nativeLoginState = { status: 'error', message: error.message }; }
  renderProgress();
  try { renderChatState(unwrap(await api.chatStatus())); } catch { /* retain the last visible login state */ }
  if (nativeLoginState.status === 'success') {
    setTimeout(() => {
      if (nativeLoginState.status === 'success') { nativeLoginState = { status: 'idle', message: '' }; renderProgress(); }
    }, 12000);
  }
}
async function runLoginAction(method) {
  try { renderChatState(unwrap(await api[method]())); }
  catch (error) { $('#loginDialogMessage').textContent = error.message; }
}
function renderLogin() {
  const dialog = $('#loginDialog');
  if (!loginState.prompt) { if (dialog.open) dialog.close(); return; }
  const external = loginState.mode === 'native';
  const busy = external && ['starting', 'syncing', 'closing'].includes(nativeLoginState.status);
  $('#loginDialogTitle').textContent = external ? nativeLoginState.status === 'syncing' ? '登录已检测到，正在自动返回' : '请在浏览器窗口完成登录'
    : loginState.kind === 'blocked' ? '登录需要重新连接' : '在助手内登录 ChatGPT';
  $('#loginDialogMessage').textContent = loginState.message;
  $('#loginDialogBadge').textContent = external ? 'CHATGPT · 自动返回已开启' : 'CHATGPT · 应用内登录';
  $('#embeddedLoginStart').hidden = external;
  $('#embeddedLoginStart').textContent = loginState.kind === 'blocked' ? '在应用内重新登录' : '在应用内继续登录';
  $('#loginBrowserFallback').hidden = external && Boolean(nativeLoginState.active);
  $('#loginBrowserFallback').textContent = external ? '重新打开浏览器登录窗口' : '应用内遇到问题？使用 Chrome 备用登录';
  $('#loginCheckNow').hidden = !external || !nativeLoginState.active;
  $('#loginCheckNow').disabled = busy;
  $('#loginDialogCancel').disabled = external && nativeLoginState.status === 'closing';
  $('#loginDialogCancel').textContent = external ? '取消登录，返回助手' : '暂不登录，返回页面';
  $('#loginDialogNote').textContent = external ? '成功后会自动同步并返回助手，无需点击右上角按钮。遇到问题可点「立即检查」。不读取日常 Chrome 配置。'
    : '登录过程保持在应用内，账号验证完成后自动返回聊天。不会把“看到聊天页面”误当作已经登录。';
  if (!dialog.open) dialog.showModal();
}
$('#nativeLoginButton').onclick = () => runLoginAction('openLogin');
$('#embeddedLoginStart').onclick = () => runLoginAction('embeddedLogin');
$('#loginBrowserFallback').onclick = () => runNativeLogin('nativeLoginStart');
$('#loginCheckNow').onclick = () => runNativeLogin('nativeLoginFinish');
$('#loginDialogCancel').onclick = () => runLoginAction('dismissLogin');
$('#loginDialog').addEventListener('cancel', (event) => { event.preventDefault(); void runLoginAction('dismissLogin'); });
$('#nativeLoginFinish').onclick = () => runNativeLogin('nativeLoginFinish');
$('#nativeLoginCancel').onclick = () => runNativeLogin('nativeLoginCancel');
$('#progressAction').onclick = async () => {
  const action = $('#progressAction').dataset.action;
  try {
    if (action === 'stop-generation') {
      await api.stopGeneration?.();
      await refreshTask();
    } else if (action === 'reload-page') {
      await navigate('reload');
    }
  } catch (error) { $('#switchState').textContent = error.message; }
};
$('#activityToggle').onclick = (event) => {
  event.stopPropagation();
  if (activityDetailVisible && activityPopoverPinned) closeActivityPanel({ force: true });
  else openActivityPanel($('#progressDetailTrigger'), { pin: true });
};
const progressDetailTrigger = $('#progressDetailTrigger');
progressDetailTrigger?.addEventListener('mouseenter', () => scheduleActivityOpen(progressDetailTrigger));
progressDetailTrigger?.addEventListener('mouseleave', scheduleActivityClose);
progressDetailTrigger?.addEventListener('click', (event) => {
  event.stopPropagation();
  if (activityDetailVisible && activityPopoverPinned) closeActivityPanel({ force: true });
  else openActivityPanel(progressDetailTrigger, { pin: true });
});
progressDetailTrigger?.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  if (activityDetailVisible && activityPopoverPinned) closeActivityPanel({ force: true });
  else openActivityPanel(progressDetailTrigger, { pin: true });
});
$('#workspaceHealthButton').onclick = (event) => {
  event.stopPropagation();
  const popover = $('#workspaceHealthPopover');
  const nextHidden = !popover.hidden;
  popover.hidden = nextHidden;
  $('#workspaceHealthButton').setAttribute('aria-expanded', String(!nextHidden));
};
document.addEventListener('click', (event) => {
  const label = $('#workspaceLabel');
  if (!label?.contains(event.target)) {
    const popover = $('#workspaceHealthPopover');
    if (popover && !popover.hidden) {
      popover.hidden = true;
      $('#workspaceHealthButton').setAttribute('aria-expanded', 'false');
    }
  }
  const progressDetailTrigger = $('#progressDetailTrigger');
  const activityToggle = $('#activityToggle');
  if (activityPopoverPinned && !progressDetailTrigger?.contains(event.target) && !activityToggle?.contains(event.target)) closeActivityPanel({ force: true });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && activityDetailVisible) closeActivityPanel({ force: true });
});
api.onActivityDetailState?.((state) => {
  activityDetailVisible = Boolean(state?.visible);
  activityPopoverPinned = Boolean(state?.pinned);
  $('#activityToggle')?.setAttribute('aria-expanded', String(activityDetailVisible));
  $('#progressDetailTrigger')?.setAttribute('aria-expanded', String(activityDetailVisible));
  if ($('#activityToggle')) $('#activityToggle').textContent = activityPopoverPinned ? '收起详情' : '活动详情';
});
$('#managerButton').onclick = () => api.openManager();
$('#workspacePickerButton').onclick = (event) => {
  event.stopPropagation();
  api.openWorkspaceWindow?.().catch((error) => setSwitchState(`打开失败：${error.message}`, 'error'));
};
$('#stopTask').onclick = async () => {
  if (!window.confirm('停止当前正在执行的本地任务？')) return;
  try { unwrap(await api.stopTask()); await refreshTask(); }
  catch (error) { $('#switchState').textContent = error.message; }
};
$('#addAuthorizedRootQuick').onclick = async () => {
  if (switching) return;
  switching = true;
  $('#switchState').textContent = '请选择要授权的额外目录…';
  try {
    const result = unwrap(await api.chooseAuthorizedRoot());
    $('#switchState').textContent = result?.selected ? `已授权：${baseName(result.selected)}` : '';
  } catch (error) {
    $('#switchState').textContent = error.message;
  } finally {
    switching = false;
  }
};
$('#addWorkspace').onclick = async () => {
  if (switching) return;
  switching = true;
  $('#switchState').textContent = '请选择工作目录…';
  try {
    const result = unwrap(await api.chooseAndSwitchWorkspace());
    if (result) {
      $('#switchState').textContent = '工作区已添加';
      await Promise.all([refreshWorkspace(), refreshStatus(), refreshTask()]);
    } else {
      $('#switchState').textContent = '';
    }
  } catch (error) {
    $('#switchState').textContent = error.message;
  } finally {
    switching = false;
  }
};

api.onChatState(renderChatState);
api.onHeartbeat(renderServiceState);
api.onTaskEvent?.(() => refreshTask());
api.onWorkspaceChanged?.(renderWorkspace);
api.onDownload((item) => {
  const node = $('#downloadState');
  const openButton = $('#openDownloadButton');
  if (item.status === 'completed') {
    node.textContent = `已保存：${baseName(item.path)}`;
    if (openButton) openButton.hidden = false;
  }
  else if (item.status === 'progressing') node.textContent = `附件 ${item.totalBytes ? Math.round((item.receivedBytes / item.totalBytes) * 100) : 0}%`;
  else if (item.error) { node.textContent = item.error; if (openButton) openButton.hidden = true; }
});
$('#openDownloadButton').onclick = () => api.openLastDownload?.().catch((error) => { $('#downloadState').textContent = error.message; });
api.chatStatus().then((result) => renderChatState(unwrap(result))).catch(() => {});
$('#schemaRefreshHint').onclick = (event) => {
  dismissedSchemaMismatch = String(event.currentTarget?.dataset?.mismatchKey || '');
  refreshSchemaHint();
};
refreshStatus();
refreshWorkspace();
refreshTask();
refreshApprovals();
setInterval(refreshWorkspace, 60000);
setInterval(refreshTask, 30000);
setInterval(renderProgress, 1000);
setInterval(refreshApprovals, 10000);

// Local console, Git, checkpoint and handoff tools retained during upstream integration.
let lastTaskStatus = null;

// WebContentsView (ChatGPT) is a native layer above HTML overlays.
// Tell main process how much room console drawer / hanging popovers need.
function hangOverlaySelectors() {
  return ['#taskHistoryPopover', '#contextUsagePopover', '#workspaceHealthPopover', '#workspaceCleanPopover'];
}

function hangOverlaysOpen() {
  return hangOverlaySelectors().some((selector) => {
    const el = $(selector);
    return el && !el.hidden;
  });
}

function closeHangOverlays(exceptSelector = '') {
  const map = {
    '#taskHistoryPopover': () => toggleTaskHistory(false),
    '#contextUsagePopover': () => {
      const popover = $('#contextUsagePopover');
      if (popover) popover.hidden = true;
      $('#contextUsageButton')?.setAttribute('aria-expanded', 'false');
    },
    '#workspaceHealthPopover': () => {
      const popover = $('#workspaceHealthPopover');
      if (popover) popover.hidden = true;
      $('#workspaceHealthButton')?.setAttribute('aria-expanded', 'false');
    },
    '#workspaceCleanPopover': () => toggleWorkspaceCleanPopover(false),
  };
  for (const selector of Object.keys(map)) {
    if (selector === exceptSelector) continue;
    try { map[selector](); } catch { /* ignore */ }
  }
}

function syncChatContentInsets() {
  if (!api?.setContentInsets) return;
  const drawer = $('#taskConsoleDrawer');
  let bottom = 0;
  if (drawer && !drawer.hidden) {
    const rect = drawer.getBoundingClientRect();
    // Clamp so a short window cannot get an inset larger than the content area.
    bottom = Math.round(Math.min(rect.height || 320, window.innerHeight * 0.55));
  }
  const toolbar = $('.browser-toolbar');
  const toolbarHeight = toolbar ? Math.round(toolbar.getBoundingClientRect().height) : 164;
  let overlayBottom = 0;
  for (const selector of hangOverlaySelectors()) {
    const el = $(selector);
    if (!el || el.hidden) continue;
    const rect = el.getBoundingClientRect();
    overlayBottom = Math.max(overlayBottom, Math.ceil(rect.bottom));
  }
  // top overlay is measured from below the toolbar (content area origin)
  const top = Math.max(0, Math.min(overlayBottom - toolbarHeight, Math.round(window.innerHeight * 0.4)));
  Promise.resolve(api.setContentInsets({ top, bottom })).catch(() => {});
}

function playTaskCompletionSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.setValueAtTime(880, now + 0.12); // A5
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
  } catch { /* audio not allowed or failed */ }
}

let activeDiffFile = null;

async function showFileDiff(filePath) {
  const diffCol = $('#consoleDiffColumn');
  const title = $('#diffViewTitle');
  const content = $('#diffViewContent');
  if (!diffCol || !content) return;
  activeDiffFile = filePath;
  diffCol.hidden = false;
  title.textContent = `差异对比：${baseName(filePath)}`;
  content.textContent = '正在加载差异…';

  // Highlight active row
  document.querySelectorAll('.console-file-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.path === filePath);
  });

  try {
    if (!api.gitFileDiff) {
      content.textContent = '当前环境不支持 Git 对比接口。';
      return;
    }
    const result = unwrap(await api.gitFileDiff(filePath));
    const rawDiff = result?.diff || '无变更内容。';
    content.replaceChildren();
    const lines = rawDiff.split(/\r?\n/);
    for (const line of lines) {
      const span = document.createElement('span');
      if (line.startsWith('+') && !line.startsWith('+++')) {
        span.className = 'diff-line-add';
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        span.className = 'diff-line-del';
      } else if (line.startsWith('@')) {
        span.className = 'diff-line-hunk';
      } else {
        span.className = 'diff-line-normal';
      }
      span.textContent = line || ' ';
      content.appendChild(span);
    }
  } catch (err) {
    content.textContent = `加载 Diff 失败：${err.message}`;
  }
}

$('#closeDiffBtn').onclick = () => {
  const diffCol = $('#consoleDiffColumn');
  if (diffCol) diffCol.hidden = true;
  activeDiffFile = null;
  document.querySelectorAll('.console-file-item').forEach((el) => el.classList.remove('active'));
};

function renderModifiedFilesList(files = []) {
  const container = $('#consoleFilesList');
  if (!container) return;
  container.replaceChildren();
  if (!files.length) {
    const empty = document.createElement('div');
    empty.style.color = '#71717a';
    empty.style.fontStyle = 'italic';
    empty.textContent = '当前任务暂无修改文件记录。';
    container.appendChild(empty);
    return;
  }
  for (const item of files) {
    const filePath = typeof item === 'string' ? item : (item?.path || String(item));
    if (!filePath) continue;
    const itemEl = document.createElement('div');
    itemEl.className = 'console-file-item';
    itemEl.dataset.path = filePath;
    if (activeDiffFile === filePath) itemEl.classList.add('active');
    itemEl.title = `点击查看 Diff 差异，右侧定位：${filePath}`;
    
    const nameSpan = document.createElement('span');
    nameSpan.className = 'console-file-name';
    nameSpan.textContent = filePath;

    const actionSpan = document.createElement('span');
    actionSpan.className = 'console-file-action';
    actionSpan.textContent = '定位 ↗';
    actionSpan.title = '在系统资源管理器中定位';
    actionSpan.onclick = async (e) => {
      e.stopPropagation();
      if (api.showInFolder) {
        try { unwrap(await api.showInFolder(filePath)); } catch { /* ignore */ }
      }
    };

    itemEl.appendChild(nameSpan);
    itemEl.appendChild(actionSpan);

    itemEl.onclick = (e) => {
      e.stopPropagation();
      showFileDiff(filePath);
    };
    container.appendChild(itemEl);
  }
}

async function handleCreateCheckpoint() {
  const btn = $('#createCapsuleBtn');
  if (btn) btn.disabled = true;
  try {
    if (!api.createCheckpoint) return;
    const res = unwrap(await api.createCheckpoint({ manual: true }));
    const count = Object.keys(res?.fileSnapshots || {}).length;
    $('#switchState').textContent = `✅ 已创建安全基线检查点（记录 ${count} 个脏文件）`;
    setTimeout(() => { $('#switchState').textContent = ''; }, 4000);
    await Promise.all([refreshTask(), refreshTaskConsole()]);
  } catch (err) {
    alert(`创建检查点失败: ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleRollbackCheckpoint() {
  const rollbackBtn = $('#rollbackCapsuleBtn');
  let status = null;
  try {
    if (api.getCheckpointStatus) status = unwrap(await api.getCheckpointStatus());
  } catch { status = null; }

  if (!status?.canRollback) {
    alert(
      (status?.rollbackDisabledReason || '当前没有可用的安全检查点。')
      + '\n\n请先点击「创建检查点」生成任务前基线，再执行回滚。'
      + '\n安全回滚只恢复基线内文件，不会执行 git checkout HEAD，也不会重置暂存区。'
    );
    return;
  }

  const confirmed = window.confirm(
    '⚠️ 安全回滚（three-way-baseline）\n\n'
    + '将把任务修改文件恢复到检查点基线内容。\n'
    + '· 不会执行 git checkout HEAD\n'
    + '· 不会重置暂存区\n'
    + '· 未记入基线/任务列表的用户修改将被保留\n'
    + '· 若文件在检查点后被人工改动且不在任务列表中，将记为冲突并跳过\n\n'
    + '确定立即回滚？'
  );
  if (!confirmed) return;

  if (rollbackBtn) rollbackBtn.disabled = true;
  try {
    if (!api.rollbackCheckpoint) return;
    // Optional one-shot approval, then execute with confirm=true.
    let approvalId = '';
    if (api.issueApproval) {
      try {
        const issued = unwrap(await api.issueApproval({ action: 'checkpoint:rollback' }));
        approvalId = issued?.id || '';
      } catch { /* fall back to confirm-only */ }
    }
    const res = unwrap(await api.rollbackCheckpoint({
      approvalId,
      confirm: true,
      requireApproval: Boolean(approvalId),
    }));
    const diffCol = $('#consoleDiffColumn');
    if (diffCol) diffCol.hidden = true;
    activeDiffFile = null;

    const conflicts = Array.isArray(res?.conflicts) ? res.conflicts : [];
    const errors = Array.isArray(res?.errors) ? res.errors : [];
    if (res?.success) {
      $('#switchState').textContent = `✅ ${res?.message || '安全回滚完成'}`;
    } else {
      const detail = [
        res?.message || '安全回滚部分完成',
        conflicts.length ? `冲突 ${conflicts.length} 个` : '',
        errors.length ? `错误 ${errors.length} 个` : '',
      ].filter(Boolean).join('；');
      $('#switchState').textContent = `⚠️ ${detail}`;
      if (conflicts.length || errors.length) {
        alert(
          '回滚未完全成功：\n'
          + conflicts.map((c) => `冲突: ${c.path} — ${c.reason}`).join('\n')
          + (errors.length ? '\n' : '')
          + errors.map((e) => `错误: ${e}`).join('\n')
        );
      }
    }
    setTimeout(() => { $('#switchState').textContent = ''; }, 6000);
    await Promise.all([refreshTask(), refreshTaskConsole()]);
  } catch (err) {
    alert(`回滚失败: ${err.message}`);
  } finally {
    if (rollbackBtn) rollbackBtn.disabled = false;
  }
}

$('#createCapsuleBtn').onclick = () => handleCreateCheckpoint();
$('#rollbackCapsuleBtn').onclick = () => handleRollbackCheckpoint();

async function handleGitCommit(push = false) {
  const input = $('#gitCommitInput');
  const commitBtn = $('#gitCommitBtn');
  const pushBtn = $('#gitCommitPushBtn');
  const message = input?.value?.trim();
  if (!message) {
    alert('请输入 Git 提交说明（Commit Message）');
    input?.focus();
    return;
  }
  if (commitBtn) commitBtn.disabled = true;
  if (pushBtn) pushBtn.disabled = true;
  try {
    if (!api.gitCommitAndPush) return;
    const res = unwrap(await api.gitCommitAndPush({ message, push }));
    input.value = '';
    $('#switchState').textContent = push ? 'Git 提交并推送成功' : 'Git 提交成功';
    setTimeout(() => { $('#switchState').textContent = ''; }, 3000);
    // Refresh diff view if open
    if (activeDiffFile) showFileDiff(activeDiffFile);
  } catch (err) {
    alert(`Git 操作失败: ${err.message}`);
  } finally {
    if (commitBtn) commitBtn.disabled = false;
    if (pushBtn) pushBtn.disabled = false;
  }
}

$('#gitCommitBtn').onclick = () => handleGitCommit(false);
$('#gitCommitPushBtn').onclick = () => handleGitCommit(true);
function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes || 0));
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function renderContextUsage(usage) {
  if (!usage) return;
  const dot = $('#contextUsageButton .context-dot');
  const summary = $('#contextUsageSummary');
  const level = usage.pressureLevel || 'safe';
  if (dot) {
    dot.className = `context-dot ${level}`;
  }
  const tokenK = (usage.totalTokens / 1000).toFixed(1);
  if (summary) {
    summary.textContent = `MCP 负载 ${tokenK}k`;
  }
  const button = $('#contextUsageButton');
  if (button) {
    const levelZh = { safe: '流量较小', moderate: '流量中等', heavy: '流量偏大' }[level] || '正常';
    button.title = `本地 MCP 工具流量估算: ${usage.totalTokens} tokens (~${Math.round(usage.totalBytes / 1024)} KB, ${levelZh})。这是累计请求/响应体积，不等于 ChatGPT 上下文占用。`;
  }

  const progress = $('#contextUsageProgress');
  if (progress) {
    progress.style.width = `${usage.percent}%`;
    progress.className = level;
  }
  const percentLabel = $('#contextUsagePercent');
  if (percentLabel) {
    const budgetK = Math.round((usage.contextBudget || 128000) / 1000);
    percentLabel.textContent = `${usage.percent}% / ${budgetK}k`;
  }

  if ($('#contextTotalTokens')) $('#contextTotalTokens').textContent = `${usage.totalTokens.toLocaleString()} 估 tokens`;
  if ($('#contextTotalBytes')) $('#contextTotalBytes').textContent = formatBytes(usage.totalBytes);
  if ($('#contextRequestBytes')) $('#contextRequestBytes').textContent = formatBytes(usage.requestBytes || 0);
  if ($('#contextResponseBytes')) $('#contextResponseBytes').textContent = formatBytes(usage.responseBytes || 0);
  if ($('#contextCallCount')) $('#contextCallCount').textContent = `${usage.callCount || 0} 次`;
  if ($('#contextSessionId')) {
    const sid = String(usage.sessionId || '');
    $('#contextSessionId').textContent = sid ? sid : '未同步';
    $('#contextSessionId').title = sid || 'Runtime 未上报 session_id';
  }

  if ($('#contextMaxCall')) {
    if (usage.maxCall) {
      $('#contextMaxCall').textContent = `${usage.maxCall.tool} ${formatBytes(usage.maxCall.bytes)}`;
    } else {
      $('#contextMaxCall').textContent = '-';
    }
  }
  if ($('#contextLastCall')) {
    if (usage.lastCall) {
      $('#contextLastCall').textContent = `${usage.lastCall.tool} ${formatBytes(usage.lastCall.bytes)}`;
    } else {
      $('#contextLastCall').textContent = '-';
    }
  }

  const toolsWrap = $('#contextTopTools');
  const toolsList = $('#contextTopToolsList');
  if (toolsWrap && toolsList) {
    const topTools = Array.isArray(usage.topTools) ? usage.topTools : [];
    if (!topTools.length) {
      toolsWrap.hidden = true;
      toolsList.replaceChildren();
    } else {
      toolsWrap.hidden = false;
      toolsList.replaceChildren();
      for (const item of topTools) {
        const row = document.createElement('div');
        row.className = 'popover-tool-row';
        const name = document.createElement('strong');
        name.textContent = item.tool;
        const bytes = document.createElement('span');
        bytes.textContent = formatBytes(item.bytes);
        const calls = document.createElement('span');
        calls.textContent = `${item.calls} 次`;
        row.append(name, bytes, calls);
        toolsList.appendChild(row);
      }
    }
  }

  const tip = $('#contextUsageTip');
  if (tip) {
    if (level === 'heavy') {
      tip.textContent = '本地 MCP 工具累计流量较大（多次大文件/大 diff 返回）。这是流量估算，不是 ChatGPT 上下文窗口；若模型变慢，可点「新对话」清空会话。';
      tip.style.color = 'var(--red)';
    } else if (level === 'moderate') {
      tip.textContent = '本地 MCP 工具累计流量中等。数字来自 performance.json 的 request/response 字节估算。';
      tip.style.color = '#b37700';
    } else {
      tip.textContent = '本地 MCP 工具流量较低。该数字是请求/响应体积估算，不等于 ChatGPT 上下文占用。';
      tip.style.color = 'var(--muted)';
    }
  }
}

function statusBadgeClass(status) {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'stopped') return 'failed';
  return 'other';
}

async function refreshTaskHistoryList() {
  const list = $('#taskHistoryList');
  if (!list) return;
  if (!api.taskHistory) {
    list.innerHTML = '<div class="task-history-empty">当前环境不支持任务历史接口。</div>';
    return;
  }
  list.innerHTML = '<div class="task-history-empty">加载中…</div>';
  try {
    const history = unwrap(await api.taskHistory());
    const items = Array.isArray(history) ? history : (history?.items || []);
    if (!Array.isArray(items) || items.length === 0) {
      list.innerHTML = '<div class="task-history-empty">暂无历史任务。任务完成后会归档到工作区 .coding-tools/task-history.json。</div>';
      return;
    }
    list.replaceChildren();
    for (const task of items) {
      const row = document.createElement('div');
      row.className = `task-history-row ${statusBadgeClass(task.status)}`;
      const header = document.createElement('header');
      const title = document.createElement('b');
      title.textContent = task.objective || '未命名任务';
      title.title = task.objective || '';
      const badge = document.createElement('span');
      badge.className = `status ${statusBadgeClass(task.status)}`;
      badge.textContent = task.status || 'unknown';
      header.append(title, badge);
      const meta = document.createElement('small');
      const when = new Date(task.archived_at || task.updated_at || task.created_at || Date.now());
      const metaBits = [when.toLocaleString('zh-CN'), String(task.task_id || '').slice(0, 8)];
      if (task.current_step) metaBits.push(task.current_step);
      meta.textContent = metaBits.join(' · ');
      row.append(header, meta);

      const failureText = String(task.failure || '').trim();
      const isFailed = task.status === 'failed' || task.status === 'stopped';
      if (isFailed || failureText) {
        const failure = document.createElement('div');
        failure.className = 'failure';
        const reason = failureText && !/^agent_workflow:\s*completed\.?$/i.test(failureText)
          ? failureText
          : (failureText
            ? `失败（Runtime 未写入具体原因）：${failureText}`
            : '失败，但未记录 failure 字段');
        failure.textContent = `失败原因：${reason}`;
        row.appendChild(failure);
      }

      const lastCmd = task.last_command || null;
      if (lastCmd && (isFailed || lastCmd.status === 'failed')) {
        const cmdLine = document.createElement('div');
        cmdLine.className = 'last-cmd';
        cmdLine.title = String(lastCmd.command || '');
        const label = document.createElement('span');
        label.textContent = '最后命令：';
        const code = document.createElement('code');
        code.textContent = String(lastCmd.command || '-');
        cmdLine.append(label, code);
        row.appendChild(cmdLine);
        if (lastCmd.workdir) {
          const wd = document.createElement('div');
          wd.className = 'last-cmd';
          wd.textContent = `工作目录：${lastCmd.workdir}`;
          row.appendChild(wd);
        }
      }

      const failedStep = Array.isArray(task.steps)
        ? task.steps.find((s) => s?.status === 'failed')
        : null;
      if (failedStep) {
        const stepLine = document.createElement('div');
        stepLine.className = 'last-cmd';
        stepLine.textContent = `失败步骤：${failedStep.id || ''} ${failedStep.text || ''}`.trim();
        row.appendChild(stepLine);
      }

      list.appendChild(row);
    }
  } catch (error) {
    list.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'task-history-empty';
    empty.textContent = `读取失败：${error.message || error}`;
    list.appendChild(empty);
  }
}

function toggleTaskHistory(force) {
  const popover = $('#taskHistoryPopover');
  const btn = $('#openTaskHistoryButton');
  if (!popover || !btn) return;
  const nextHidden = typeof force === 'boolean' ? !force : !popover.hidden;
  if (!nextHidden) closeHangOverlays('#taskHistoryPopover');
  popover.hidden = nextHidden;
  btn.setAttribute('aria-expanded', String(!nextHidden));
  if (!nextHidden) refreshTaskHistoryList();
  requestAnimationFrame(syncChatContentInsets);
}

async function refreshContextUsage() {
  if (!api.contextUsage) return;
  try {
    const result = unwrap(await api.contextUsage());
    renderContextUsage(result);
  } catch { /* ignore if not available */ }
}

$('#contextUsageButton').onclick = (event) => {
  event.stopPropagation();
  const popover = $('#contextUsagePopover');
  if (!popover) return;
  const nextHidden = !popover.hidden;
  popover.hidden = nextHidden;
  $('#contextUsageButton').setAttribute('aria-expanded', String(!nextHidden));
  if (!nextHidden) refreshContextUsage();
  requestAnimationFrame(syncChatContentInsets);
};
$('#resetContextUsage').onclick = async (event) => {
  event.stopPropagation();
  try {
    if (api.navigate) {
      await api.navigate('home');
    }
    if (api.resetContextUsage) {
      const result = unwrap(await api.resetContextUsage());
      renderContextUsage(result);
    }
    const popover = $('#contextUsagePopover');
    if (popover) {
      popover.hidden = true;
      $('#contextUsageButton')?.setAttribute('aria-expanded', 'false');
    }
  } catch { /* ignore */ }
};
$('#continueContextUsage').onclick = async (event) => {
  event.stopPropagation();
  const btn = $('#continueContextUsage');
  if (btn) btn.disabled = true;
  try {
    let snapshotText = '';
    if (api.generateTaskSnapshot) {
      try {
        const snap = unwrap(await api.generateTaskSnapshot());
        snapshotText = snap?.snapshot || '';
      } catch { /* ignore */ }
    }
    if (api.navigate) {
      await api.navigate('home');
    }
    if (api.resetContextUsage) {
      const result = unwrap(await api.resetContextUsage());
      renderContextUsage(result);
    }
    const popover = $('#contextUsagePopover');
    if (popover) {
      popover.hidden = true;
      $('#contextUsageButton')?.setAttribute('aria-expanded', 'false');
    }
    if (snapshotText) {
      // Copy to clipboard as reliable fallback
      try { await navigator.clipboard.writeText(snapshotText); } catch {}
      // Schedule injection when page is ready
      setTimeout(async () => {
        try {
          if (api.injectPrompt) {
            await api.injectPrompt(snapshotText, true);
          }
        } catch { /* fallback already copied to clipboard */ }
      }, 1600);
      $('#switchState').textContent = '已开启新会话并自动继承任务记忆';
      setTimeout(() => { $('#switchState').textContent = ''; }, 3000);
    }
  } catch (err) {
    $('#switchState').textContent = err.message;
  } finally {
    if (btn) btn.disabled = false;
  }
};
document.addEventListener('click', (event) => {
  const wrap = $('#contextUsageWrap');
  if (wrap?.contains(event.target)) return;
  const popover = $('#contextUsagePopover');
  if (popover && !popover.hidden) {
    popover.hidden = true;
    $('#contextUsageButton')?.setAttribute('aria-expanded', 'false');
    requestAnimationFrame(syncChatContentInsets);
  }
});

let consolePollTimer = null;
let lastConsoleLogText = '';

function formatConsoleLine(line) {
  const div = document.createElement('span');
  div.className = 'console-line';
  const text = String(line || '');
  if (/error|failed|exception|traceback|stderr|fatal/i.test(text)) {
    div.classList.add('stderr');
  } else if (/success|passed|ok|ready/i.test(text)) {
    div.classList.add('success');
  } else if (/info|running|start|step/i.test(text)) {
    div.classList.add('info');
  }
  div.textContent = text;
  return div;
}

async function refreshTaskConsole() {
  if (!api.readTaskConsole) return;
  const drawer = $('#taskConsoleDrawer');
  if (!drawer || drawer.hidden) return;
  try {
    const data = unwrap(await api.readTaskConsole());
    const commandBadge = $('#consoleActiveCommand');
    const killBtn = $('#killConsoleBtn');
    const output = $('#consoleOutput');
    const autoScroll = $('#consoleAutoScroll')?.checked;

    if (data.runningCommand) {
      const cmd = data.runningCommand.command || '运行中…';
      commandBadge.textContent = cmd.length > 50 ? `${cmd.slice(0, 47)}…` : cmd;
      commandBadge.className = 'console-command-badge running';
      commandBadge.title = `${data.runningCommand.command} (工作目录: ${data.runningCommand.workdir || '-'})`;
      killBtn.disabled = false;
    } else if (data.status === 'active') {
      commandBadge.textContent = data.currentStep || '任务执行中';
      commandBadge.className = 'console-command-badge running';
      commandBadge.title = data.objective || '';
      killBtn.disabled = false;
    } else {
      commandBadge.textContent = data.status === 'stopped' ? '已终止' : (data.status === 'completed' ? '已完成' : '空闲');
      commandBadge.className = 'console-command-badge';
      commandBadge.title = '';
      killBtn.disabled = true;
    }

    const logLines = Array.isArray(data.logs) ? data.logs : [];
    const joined = logLines.join('\n');
    if (joined !== lastConsoleLogText) {
      lastConsoleLogText = joined;
      output.replaceChildren();
      for (const line of logLines) {
        output.appendChild(formatConsoleLine(line));
      }
      if (autoScroll) {
        output.scrollTop = output.scrollHeight;
      }
    }
  } catch { /* ignore if failed */ }
}

function toggleTaskConsole(forceOpen) {
  const drawer = $('#taskConsoleDrawer');
  if (!drawer) return;
  const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : drawer.hidden;
  if (nextOpen) {
    // Drawer + hanging popovers together double-inset the ChatGPT view and look "deformed".
    closeHangOverlays();
  }
  drawer.hidden = !nextOpen;
  if (nextOpen) {
    refreshTaskConsole();
    if (!consolePollTimer) {
      consolePollTimer = setInterval(refreshTaskConsole, 1200);
    }
  } else {
    if (consolePollTimer) {
      clearInterval(consolePollTimer);
      consolePollTimer = null;
    }
  }
  // Double rAF: wait one paint for drawer layout before measuring height.
  requestAnimationFrame(() => {
    requestAnimationFrame(syncChatContentInsets);
  });
}

$('#openTerminalButton').onclick = (event) => {
  event.stopPropagation();
  toggleTaskConsole();
};
$('#openTaskHistoryButton').onclick = (event) => {
  event.stopPropagation();
  toggleTaskHistory();
};
$('#refreshTaskHistoryBtn').onclick = async (event) => {
  event.stopPropagation();
  await refreshTaskHistoryList();
};
$('#closeConsoleBtn').onclick = () => toggleTaskConsole(false);
$('#clearConsoleBtn').onclick = () => {
  lastConsoleLogText = '';
  $('#consoleOutput').replaceChildren();
};
$('#copyConsoleBtn').onclick = async () => {
  const text = $('#consoleOutput')?.innerText || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const btn = $('#copyConsoleBtn');
    const oldText = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = oldText; }, 1500);
  } catch { /* clipboard write failed */ }
};
$('#killConsoleBtn').onclick = async () => {
  if (!api.killActiveCommand) return;
  if (!window.confirm('确定要强行终止当前正在执行的命令/任务吗？')) return;
  try {
    unwrap(await api.killActiveCommand());
    await Promise.all([refreshTask(), refreshTaskConsole()]);
  } catch (error) {
    $('#switchState').textContent = error.message;
  }
};

$('#openInExplorerBtn').onclick = async (event) => {
  event.stopPropagation();
  if (api.openWorkspaceInExplorer) {
    try { unwrap(await api.openWorkspaceInExplorer()); }
    catch (error) { $('#switchState').textContent = error.message; }
  }
};

$('#openInEditorBtn').onclick = async (event) => {
  event.stopPropagation();
  if (api.openWorkspaceInEditor) {
    try { unwrap(await api.openWorkspaceInEditor()); }
    catch (error) { $('#switchState').textContent = error.message; }
  }
};

function switchConsoleTab(tabName) {
  const isLogs = tabName === 'logs';
  $('#consoleTabLogs')?.classList.toggle('active', isLogs);
  $('#consoleTabFiles')?.classList.toggle('active', !isLogs);
  const output = $('#consoleOutput');
  const filesView = $('#consoleFilesView');
  const autoScrollWrap = $('#consoleAutoScrollWrap');
  if (output) output.hidden = !isLogs;
  if (filesView) filesView.hidden = isLogs;
  if (autoScrollWrap) autoScrollWrap.style.display = isLogs ? 'inline-flex' : 'none';
}

$('#consoleTabLogs').onclick = () => switchConsoleTab('logs');
$('#consoleTabFiles').onclick = () => switchConsoleTab('files');
$('#taskChangesBtn').onclick = (event) => {
  event.stopPropagation();
  toggleTaskConsole(true);
  switchConsoleTab('files');
};


async function refreshLocalTaskTools(task) {
  const modifiedFiles = Array.isArray(task?.modified_files) ? task.modified_files : [];
  const changesBtn = $('#taskChangesBtn');
  changesBtn.hidden = modifiedFiles.length === 0;
  changesBtn.textContent = `📝 ${modifiedFiles.length} 文件`;
  $('#consoleFilesCount').textContent = String(modifiedFiles.length);
  renderModifiedFilesList(modifiedFiles);
  const status = String(task?.status || 'idle');
  if (lastTaskStatus && lastTaskStatus !== status && status === 'completed') playTaskCompletionSound();
  lastTaskStatus = status;
  const rollbackBtn = $('#rollbackCapsuleBtn');
  const capsuleBadge = $('#capsuleStatusBadge');
  try {
    const checkpoint = unwrap(await api.getCheckpointStatus());
    capsuleBadge.textContent = checkpoint.hasCapsule ? '💾 胶囊已就绪' : '胶囊未创建';
    capsuleBadge.classList.toggle('ready', Boolean(checkpoint.hasCapsule));
    rollbackBtn.disabled = !checkpoint.canRollback;
    rollbackBtn.title = checkpoint.rollbackDisabledReason || '基于任务前基线安全回滚';
  } catch {
    rollbackBtn.disabled = true;
    capsuleBadge.textContent = '检查点状态暂不可用';
  }
}
api.onContextUsage?.(renderContextUsage);
refreshContextUsage();
setInterval(refreshContextUsage, 10000);
document.addEventListener('click', (event) => {
  if (!$('.task-history-wrap')?.contains(event.target)) toggleTaskHistory(false);
});
window.addEventListener('resize', () => {
  if (!$('#taskConsoleDrawer')?.hidden || hangOverlaysOpen()) requestAnimationFrame(syncChatContentInsets);
});

api.onThemeChanged?.((mode) => {
  const theme = mode === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
  document.body.dataset.theme = theme;
  document.documentElement.dataset.theme = theme;
});
