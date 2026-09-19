const api = window.browserAssistant;
const $ = (selector) => document.querySelector(selector);
let switching = false;
let activeWorkspace = '';
let recentWorkspaceHub = null;
let lastRuntimeState = null;
let lastRuntimeCheckAt = 0;
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
  const toolbarHeight = toolbar ? Math.round(toolbar.getBoundingClientRect().height) : 112;
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

function unwrap(result) {
  if (!result?.ok) throw new Error(result?.error || '操作失败');
  return result.data;
}

function baseName(value) {
  return String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value || '未选择';
}

function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes || 0));
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}分${rest}秒`;
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
}

function backgroundOperationStatus(operation) {
  const status = String(operation?.status || '');
  if (status === 'interrupted') return '后台任务已中断，可恢复';
  if (status === 'failed') return '后台任务执行失败';
  if (status === 'completed') return '后台任务已完成';
  if (status !== 'running') return '';
  const heartbeatAge = Number(operation?.heartbeat_age_seconds ?? 0);
  if (heartbeatAge >= 15) return `后台任务心跳异常（${heartbeatAge}秒未更新）`;
  return '后台任务运行正常';
}

function humanizeTaskText(value) {
  const raw = String(value || '').trim();
  const key = raw.toLowerCase();
  const labels = {
    'waiting for model': '等待模型继续处理',
    'waiting for user': '等待你处理',
    completed: '已完成',
    'verification failed': '验证失败',
    'requested check failed': '检查失败',
    'running requested checks': '正在执行检查',
    'run complete agent workflow': '正在执行完整任务',
    'apply workspace changes': '正在修改项目',
    'run requested checks': '正在验证修改',
    'finalize verified result': '正在整理结果'
  };
  return labels[key] || raw;
}

function progressForTask(task, status) {
  if (status === 'completed') return 100;
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  if (steps.length) {
    const completed = steps.filter((step) => String(step?.status || '') === 'completed').length;
    const active = steps.filter((step) => ['in_progress', 'active', 'running'].includes(String(step?.status || ''))).length;
    return Math.max(status === 'active' ? 5 : 0, Math.min(95, Math.round(((completed + active * 0.5) / steps.length) * 100)));
  }
  const kind = String(task?.current_command?.kind || '');
  if (kind === 'build') return 85;
  if (kind === 'test') return 72;
  if (kind === 'command') return 52;
  const step = String(task?.current_step || '').toLowerCase();
  if (step.includes('completed')) return 100;
  if (step.includes('build')) return 82;
  if (step.includes('test') || step.includes('verify')) return 70;
  if (step.includes('apply') || step.includes('modify') || step.includes('patch')) return 42;
  if (status === 'waiting') return 62;
  if (status === 'paused') return 50;
  if (status === 'failed' || status === 'stopped') return 100;
  return status === 'active' ? 18 : 0;
}

function progressLabelForTask(task, status, runningOperation, command) {
  if (runningOperation || (command && String(command.status || '') === 'running')) return '运行中';
  if (status === 'completed') return '100%';
  if (status === 'failed') return '失败';
  if (status === 'stopped') return '已停止';
  if (status === 'paused') return '已暂停';
  if (status === 'waiting') return '等待';
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  if (steps.length) {
    const completed = steps.filter((step) => String(step?.status || '') === 'completed').length;
    return `${completed}/${steps.length}`;
  }
  return status === 'active' ? '进行中' : '';
}

function renderChatState(state) {
  if (!state) return;
  $('#backButton').disabled = !state.canGoBack;
  $('#forwardButton').disabled = !state.canGoForward;
  const element = $('#pageState');
  element.classList.toggle('loading', Boolean(state.loading));
  element.classList.toggle('ready', !state.loading && !state.error);
  element.classList.toggle('error', Boolean(state.error));
  element.querySelector('span').textContent = state.error
    ? `加载失败：${state.error}`
    : state.loading ? '正在切换页面…' : 'ChatGPT 已就绪';
}

function renderServiceState(state) {
  lastRuntimeState = state || null;
  lastRuntimeCheckAt = Date.now();
  const connectionRunning = state?.tunnelRunning;
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
    const items = unwrap(await api.taskHistory());
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

async function refreshStatus() {
  try { renderServiceState(unwrap(await api.lightweightStatus())); }
  catch { renderServiceState(null); }
}

async function refreshTask() {
  try {
    let runtime = null;
    if (api.taskRuntime) {
      try { runtime = unwrap(await api.taskRuntime()); } catch { runtime = null; }
    }
    let fallbackPayload = null;
    if (!runtime?.state) {
      try { fallbackPayload = unwrap(await api.taskState()); } catch { fallbackPayload = null; }
    }
    let task = runtime?.state || fallbackPayload?.state || null;
    const activeWorktree = runtime?.active_worktree && runtime.active_worktree.exists !== false ? runtime.active_worktree : null;
    const runningOperation = Array.isArray(runtime?.operations)
      ? runtime.operations.filter((item) => item?.status === 'running').slice(-1)[0]
      : null;
    const now = Date.now();
    let status = String(task?.status || (runningOperation ? 'active' : 'idle'));
    if (task && ['completed', 'failed', 'stopped'].includes(status) && !runningOperation && !activeWorktree) {
      const terminalUpdatedAt = Date.parse(task.updated_at || task.created_at || '') || now;
      const keepVisibleMs = status === 'completed' ? 30000 : status === 'failed' ? 600000 : 120000;
      if (now - terminalUpdatedAt > keepVisibleMs) {
        task = null;
        status = 'idle';
      }
    }
    const strip = $('#taskStrip');
    strip.className = `task-strip ${status}`;
    strip.classList.toggle('isolated', Boolean(activeWorktree));
    $('#taskTitle').textContent = task?.objective || (runningOperation ? '后台任务运行中' : '暂无任务');
    if ((!task || status === 'idle') && !runningOperation) {
      $('#taskStep').textContent = '';
      $('#taskProgressBar').style.width = '0%';
      $('#taskProgressText').textContent = '';
      strip.title = '';
      return;
    }
    const createdAt = Date.parse(task.created_at || task.updated_at || '') || now;
    const updatedAt = Date.parse(task.updated_at || task.created_at || '') || createdAt;
    const elapsed = formatDuration(now - createdAt);
    const idleFor = now - updatedAt;
    const progress = progressForTask(task, status);
    const parts = [humanizeTaskText(task?.current_step || task?.next_step) || '任务处理中'];
    if (activeWorktree) parts.unshift('安全隔离中');
    if (runningOperation) {
      const operationStartedAt = Date.parse(runningOperation.started_at || '') || (now - Number(runningOperation.elapsed_seconds || 0) * 1000);
      const heartbeatAt = Date.parse(runningOperation.heartbeat_at || '');
      const heartbeatAge = Number.isFinite(heartbeatAt)
        ? Math.max(0, Math.floor((now - heartbeatAt) / 1000))
        : Number(runningOperation.heartbeat_age_seconds || 0);
      const heartbeatText = heartbeatAge >= 15 ? `心跳偏慢 ${heartbeatAge}秒前` : `心跳 ${heartbeatAge}秒前`;
      parts.unshift(`${backgroundOperationStatus({ ...runningOperation, heartbeat_age_seconds: heartbeatAge })} · 已运行 ${formatDuration(now - operationStartedAt)} · ${heartbeatText}`);
    }
    const command = task?.current_command && typeof task.current_command === 'object' ? task.current_command : null;
    if (command && String(command.status || '') === 'running') {
      const commandStartedAt = Date.parse(command.started_at || '') || now;
      const kind = { build: '构建', test: '测试', command: '命令' }[String(command.kind || '')] || '命令';
      parts.unshift(`${kind} ${formatDuration(now - commandStartedAt)}`);
    }
    if (['active', 'paused'].includes(status)) parts.push(`已运行 ${elapsed}`);
    if (status === 'active' && idleFor >= 30000 && !runningOperation) parts.push(`最近活动 ${formatDuration(idleFor)}前`);
    if (status === 'active' && idleFor >= 120000 && !runningOperation) parts.push('较长时间没有新的任务状态，正在等待下一次更新');
    const failureText = String(task?.failure || '').trim();
    if (status === 'failed' || status === 'stopped' || failureText) {
      const reason = failureText && !/^agent_workflow:\s*completed\.?$/i.test(failureText)
        ? failureText
        : (failureText ? `Runtime 未写入具体原因（${failureText}）` : '未记录 failure 字段');
      parts.push(`失败原因：${reason}`);
      const failedCmd = task?.last_command;
      if (failedCmd?.command) parts.push(`最后命令：${failedCmd.command}`);
    }
    $('#taskStep').textContent = parts.filter(Boolean).join(' · ');
    $('#taskProgressBar').style.width = `${progress}%`;
    $('#taskProgressText').textContent = progressLabelForTask(task, status, runningOperation, command);
    strip.title = `状态：${status}；阶段进度：${progress}%；最后更新：${new Date(updatedAt).toLocaleString('zh-CN')}${failureText ? `\n失败原因：${failureText}` : ''}`;

    const modifiedFiles = Array.isArray(task?.modified_files) ? task.modified_files : [];
    const changesBtn = $('#taskChangesBtn');
    if (changesBtn) {
      if (modifiedFiles.length > 0) {
        changesBtn.hidden = false;
        changesBtn.textContent = `📝 ${modifiedFiles.length} 文件`;
        changesBtn.title = `本次任务已修改 ${modifiedFiles.length} 个文件，点击查看详情`;
      } else {
        changesBtn.hidden = true;
      }
    }
    $('#consoleFilesCount').textContent = String(modifiedFiles.length);
    renderModifiedFilesList(modifiedFiles);

    const rollbackBtn = $('#rollbackCapsuleBtn');
    const capsuleBadge = $('#capsuleStatusBadge');
    if (rollbackBtn) {
      // Enabled only when a three-way-baseline capsule exists (checked below).
      rollbackBtn.disabled = true;
      rollbackBtn.textContent = '⏪ 安全回滚';
      rollbackBtn.title = '基于任务前基线安全回滚；不会 git checkout HEAD，不会重置暂存区';
    }
    if (api.getCheckpointStatus) {
      api.getCheckpointStatus().then((res) => {
        if (res?.ok && res.data) {
          if (capsuleBadge) {
            if (res.data.hasCapsule) {
              const time = res.data.capsule?.createdAt ? new Date(res.data.capsule.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
              capsuleBadge.textContent = time ? `💾 胶囊已就绪 (${time})` : '💾 胶囊已就绪';
              capsuleBadge.classList.add('ready');
              capsuleBadge.title = `安全基线已建立：${res.data.capsule?.description || ''}`;
            } else {
              capsuleBadge.textContent = '胶囊未创建';
              capsuleBadge.classList.remove('ready');
              capsuleBadge.title = '尚未为当前工作区创建任务前安全基线';
            }
          }
          if (rollbackBtn) {
            const can = Boolean(res.data.canRollback);
            rollbackBtn.disabled = !can;
            rollbackBtn.textContent = can ? '⏪ 安全回滚' : '⏪ 回滚（先建基线）';
            rollbackBtn.title = can
              ? '基于任务前基线安全回滚；不会 git checkout HEAD，不会重置暂存区'
              : (res.data.rollbackDisabledReason || '请先创建安全基线检查点');
          }
        }
      }).catch(() => {});
    }

    // 任务状态转换音效提醒
    if (lastTaskStatus && lastTaskStatus !== status) {
      if (status === 'completed') {
        playTaskCompletionSound();
      }
    }
    lastTaskStatus = status;
  } catch { /* no active workspace/task yet */ }
}

function renderWorkspace(hub) {
  activeWorkspace = hub.activeWorkspace || '';
  recentWorkspaceHub = hub;
  $('#activeWorkspace').textContent = activeWorkspace || '未选择';
  $('#activeWorkspace').title = activeWorkspace;
  renderWorkspaceHealth();
  renderWorkspaceClean(hub);
  const select = $('#workspaceSelect');
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = `\u5168\u90e8\u5de5\u4f5c\u533a（${(hub.recentWorkspaces || []).length}）`;
  select.appendChild(placeholder);
  (hub.recentWorkspaces || []).filter(Boolean).forEach((workspace) => {
    const option = document.createElement('option');
    option.value = workspace;
    option.textContent = workspace === activeWorkspace ? `\u5f53\u524d：${baseName(workspace)}` : baseName(workspace);
    option.title = workspace;
    select.appendChild(option);
  });
  select.value = '';
}

function renderWorkspaceClean(hub) {
  const list = $('#workspaceCleanList');
  list.replaceChildren();
  const entries = (hub.recentWorkspaces || []).filter(Boolean);
  const cleanActiveBtn = $('#workspaceCleanActive');
  if (cleanActiveBtn) {
    cleanActiveBtn.disabled = !activeWorkspace;
    cleanActiveBtn.title = activeWorkspace ? `退出并解除当前工作区绑定：${activeWorkspace}` : '当前未选择工作区';
  }
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.textContent = '暂无最近工作区记录。';
    list.appendChild(empty);
    $('#workspaceCleanAll').disabled = true;
    return;
  }
  $('#workspaceCleanAll').disabled = false;
  entries.forEach((workspace) => {
    const row = document.createElement('div');
    row.className = 'workspace-clean-row';
    const isCurrent = workspaceKeyEquals(workspace, activeWorkspace);
    const name = document.createElement('code');
    name.textContent = baseName(workspace);
    name.title = workspace;
    row.appendChild(name);
    if (isCurrent) {
      const tag = document.createElement('span');
      tag.className = 'workspace-clean-current';
      tag.textContent = '当前';
      row.appendChild(tag);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '✕';
      remove.title = '退出并清空当前工作区';
      remove.onclick = () => handleClearActiveWorkspace();
      row.appendChild(remove);
    } else {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '✕';
      remove.title = `移除记录：${workspace}`;
      remove.onclick = () => removeRecentWorkspaces([workspace]);
      row.appendChild(remove);
    }
    list.appendChild(row);
  });
}

function workspaceKeyEquals(left, right) {
  const key = (value) => String(value || '').trim().replace(/[\\/]+$/, '').toLowerCase();
  return Boolean(left && right) && key(left) === key(right);
}

function toggleWorkspaceCleanPopover(show) {
  const popover = $('#workspaceCleanPopover');
  const nextHidden = typeof show === 'boolean' ? !show : !popover.hidden;
  popover.hidden = nextHidden;
  $('#workspaceCleanButton').setAttribute('aria-expanded', String(!nextHidden));
  requestAnimationFrame(syncChatContentInsets);
}

async function handleClearActiveWorkspace() {
  if (switching) return;
  if (!activeWorkspace) {
    toggleWorkspaceCleanPopover(false);
    return;
  }
  if (!window.confirm(`确定退出并解除当前绑定的工作区（${baseName(activeWorkspace)}）吗？\n退出后将不关联任何本地工作区。`)) return;
  switching = true;
  $('#switchState').textContent = '正在解除当前工作区绑定…';
  try {
    const result = unwrap(await api.clearActiveWorkspace());
    renderWorkspace(result);
    $('#switchState').textContent = '已退出工作区';
    await Promise.all([refreshWorkspace(), refreshStatus(), refreshTask()]);
    toggleWorkspaceCleanPopover(false);
    setTimeout(() => { $('#switchState').textContent = ''; }, 1800);
  } catch (error) {
    $('#switchState').textContent = error.message;
  } finally {
    switching = false;
  }
}

async function removeRecentWorkspaces(targets) {
  try {
    const result = unwrap(await api.removeRecentWorkspaces(targets));
    renderWorkspace({ activeWorkspace: result.activeWorkspace, recentWorkspaces: result.recentWorkspaces });
    $('#switchState').textContent = '最近工作区记录已更新';
    setTimeout(() => { $('#switchState').textContent = ''; }, 1800);
  } catch (error) {
    $('#switchState').textContent = error.message;
  }
}

async function refreshWorkspace() {
  try { renderWorkspace(unwrap(await api.workspaceHub())); }
  catch { /* retain the last usable workspace state */ }
}

async function switchWorkspace(workspace, showProgress = true) {
  if (switching || !workspace || workspace === activeWorkspace) return;
  switching = true;
  if (showProgress) $('#switchState').textContent = 'MCP 正在后台切换工作区…';
  try {
    unwrap(await api.switchWorkspace(workspace));
    $('#switchState').textContent = '工作区已就绪';
    await Promise.all([refreshWorkspace(), refreshStatus(), refreshTask()]);
    setTimeout(() => { $('#switchState').textContent = ''; }, 1800);
  } catch (error) {
    $('#switchState').textContent = error.message;
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
$('#workspaceHealthButton').onclick = (event) => {
  event.stopPropagation();
  const popover = $('#workspaceHealthPopover');
  const nextHidden = !popover.hidden;
  popover.hidden = nextHidden;
  $('#workspaceHealthButton').setAttribute('aria-expanded', String(!nextHidden));
  requestAnimationFrame(syncChatContentInsets);
};
document.addEventListener('click', (event) => {
  const label = $('#workspaceLabel');
  if (label?.contains(event.target)) return;
  const popover = $('#workspaceHealthPopover');
  if (popover && !popover.hidden) {
    popover.hidden = true;
    $('#workspaceHealthButton').setAttribute('aria-expanded', 'false');
    requestAnimationFrame(syncChatContentInsets);
  }
});
$('#managerButton').onclick = () => api.openManager();
$('#workspaceSelect').onchange = () => { const workspace = $('#workspaceSelect').value; $('#workspaceSelect').value = ''; if (workspace) switchWorkspace(workspace, true); };
$('#workspaceCleanButton').onclick = (event) => { event.stopPropagation(); toggleWorkspaceCleanPopover(); };
document.addEventListener('click', (event) => {
  const wrap = $('.workspace-clean-wrap');
  if (wrap?.contains(event.target)) return;
  const popover = $('#workspaceCleanPopover');
  if (popover && !popover.hidden) toggleWorkspaceCleanPopover(false);
});
document.addEventListener('click', (event) => {
  const wrap = $('.task-history-wrap');
  if (wrap?.contains(event.target)) return;
  const popover = $('#taskHistoryPopover');
  if (popover && !popover.hidden) toggleTaskHistory(false);
});
$('#workspaceCleanActive').onclick = () => handleClearActiveWorkspace();
$('#workspaceCleanAll').onclick = async () => {
  const entries = ((recentWorkspaceHub?.recentWorkspaces) || [])
    .filter((item) => item && !workspaceKeyEquals(item, activeWorkspace));
  if (!entries.length) {
    alert('当前没有可清理的其他历史记录。如需解除当前工作区，请点击“清空当前工作区”。');
    return;
  }
  if (!window.confirm(`确定清理 ${entries.length} 条最近工作区记录吗？当前工作区会保留。`)) return;
  await removeRecentWorkspaces(entries);
  toggleWorkspaceCleanPopover(false);
};
$('#pauseTask').onclick = async () => { try { unwrap(await api.pauseTask()); await refreshTask(); } catch (error) { $('#switchState').textContent = error.message; } };
$('#resumeTask').onclick = async () => { try { unwrap(await api.resumeTask()); await refreshTask(); } catch (error) { $('#switchState').textContent = error.message; } };
$('#stopTask').onclick = async () => { try { unwrap(await api.stopTask()); await refreshTask(); } catch (error) { $('#switchState').textContent = error.message; } };
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

api.onChatState(renderChatState);
api.onHeartbeat(renderServiceState);
if (api.onContextUsage) {
  api.onContextUsage((usage) => renderContextUsage(usage));
}
if (api.onThemeChanged) {
  api.onThemeChanged((theme) => {
    const next = theme === 'light' ? 'light' : 'dark';
    document.body.dataset.theme = next;
    document.documentElement.dataset.theme = next;
  });
}
api.onDownload((item) => {
  const node = $('#downloadState');
  if (item.status === 'completed') node.textContent = `已保存：${baseName(item.path)}`;
  else if (item.status === 'progressing') node.textContent = `附件 ${item.totalBytes ? Math.round((item.receivedBytes / item.totalBytes) * 100) : 0}%`;
  else if (item.error) node.textContent = item.error;
});
api.chatStatus().then((result) => renderChatState(unwrap(result))).catch(() => {});
refreshStatus();
refreshWorkspace();
refreshTask();
refreshContextUsage();
setInterval(refreshWorkspace, 15000);
setInterval(refreshTask, 3000);
setInterval(refreshContextUsage, 10000);
window.addEventListener('resize', () => {
  if (!$('#taskConsoleDrawer')?.hidden || hangOverlaysOpen()) requestAnimationFrame(syncChatContentInsets);
});
// Recompute insets after first layout and when toolbar metrics change.
window.addEventListener('load', () => requestAnimationFrame(syncChatContentInsets));
if (document.fonts?.ready) {
  document.fonts.ready.then(() => requestAnimationFrame(syncChatContentInsets)).catch(() => {});
}
