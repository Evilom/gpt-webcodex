// App-owned workspace navigation. ChatGPT and running services keep their own lifecycle.
(() => {
  const $ = (id) => document.getElementById(id);
  const sidebar = $('studioSidebar');
  let preferredOpen = true;
  let historyPending = null;
  let lastHistoryAt = 0;
  let workspacePath = '';
  let historyRevision = 0;
  let panelWidth = 340;
  let sidebarWidth = 288;
  let tab = 'activity';
  let planRevision = '';
  try { preferredOpen = localStorage.getItem('studio-sidebar') !== 'closed'; } catch {}
  try { sidebarWidth = Math.max(200, Math.min(420, Number(localStorage.getItem('studio-sidebar-width')) || 288)); } catch {}
  let preferredSidebarWidth = sidebarWidth;
  const requestLayout = () => document.dispatchEvent(new Event('studio-layout'));
  const open = () => !sidebar.inert;

  function setSidebar(visible, remember = false) {
    const restoreFocus = !visible && sidebar.contains(document.activeElement);
    if (visible && innerWidth < 1180 && !$('workbench').hidden) $('closeWorkbench').click();
    sidebar.inert = !visible;
    sidebar.setAttribute('aria-hidden', String(!visible));
    document.body.classList.toggle('studio-sidebar-open', visible);
    if (visible) resizeSidebar(preferredSidebarWidth);
    $('expandSidebar').setAttribute('aria-expanded', String(visible));
    if (restoreFocus) $('expandSidebar').focus();
    if (remember) {
      preferredOpen = visible;
      try { localStorage.setItem('studio-sidebar', visible ? 'open' : 'closed'); } catch {}
    }
    requestLayout();
  }

  function selectTab(name, focus = false) {
    tab = ['activity', 'advisors', 'connections'].includes(name) ? name : 'activity';
    document.querySelectorAll('[data-studio-tab]').forEach(button => {
      const selected = button.dataset.studioTab === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    });
    document.querySelectorAll('[data-studio-panel]').forEach(panel => { panel.hidden = panel.dataset.studioPanel !== tab; });
    document.querySelector('.workbench-content').scrollTop = 0;
    requestLayout();
  }

  function showTab(name) {
    if (innerWidth < 1180) setSidebar(false);
    selectTab(name);
    if ($('workbench').hidden || $('workbench').inert) $('workbenchToggle').click();
  }

  function renderWorkspaces(hub) {
    if (workspacePath !== hub.activeWorkspace) {
      workspacePath = hub.activeWorkspace;
      historyRevision += 1;
      lastHistoryAt = 0;
      $('studioRecentTasks').textContent = '正在读取任务记录…';
      refreshHistory(true);
    }
    const list = $('studioWorkspaceList');
    const items = Array.isArray(hub.workspaces) ? hub.workspaces : (hub.recentWorkspaces || []).map(path => ({ path }));
    list.replaceChildren();
    for (const item of items) {
      if (!item.path) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'studio-nav-item studio-workspace-item';
      const active = item.path === hub.activeWorkspace;
      button.setAttribute('aria-current', active ? 'location' : 'false');
      button.title = item.path;
      const icon = document.createElement('img');
      icon.className = 'shell-icon'; icon.src = 'icons/folder.svg'; icon.alt = '';
      const name = document.createElement('span');
      name.textContent = item.name || item.path.split(/[\\/]/).filter(Boolean).at(-1) || item.path;
      button.append(icon, name);
      button.onclick = () => document.dispatchEvent(new CustomEvent('studio-workspace-select', { detail: item.path }));
      list.append(button);
    }
    if (!list.children.length) {
      const empty = document.createElement('p');
      empty.className = 'studio-meta'; empty.textContent = '尚未添加工作区';
      list.append(empty);
    }
  }

  async function refreshHistory(force = false) {
    if (historyPending || !force && Date.now() - lastHistoryAt < 30000) return historyPending;
    historyPending = (async () => {
      const revision = historyRevision;
      const list = $('studioRecentTasks');
      try {
        const result = await window.browserAssistant.taskHistory();
        if (revision !== historyRevision) return;
        if (!result?.ok) throw new Error(result?.error?.message || '无法读取');
        const items = Array.isArray(result.data) ? result.data : result.data?.items || [];
        list.replaceChildren();
        for (const task of items.slice(0, 6)) {
          const button = document.createElement('button');
          button.className = 'studio-nav-item studio-recent-task'; button.type = 'button';
          button.textContent = task.objective || '未命名任务';
          button.title = button.textContent;
          // These are local task records, not independent ChatGPT conversations.
          button.onclick = () => { $('openTaskHistoryButton').click(); };
          list.append(button);
        }
        if (!list.children.length) {
          const empty = document.createElement('p');
          empty.className = 'studio-meta'; empty.textContent = '完成的本地任务会显示在这里';
          list.append(empty);
        }
      } catch {
        if (revision === historyRevision && !list.querySelector('button')) list.textContent = '任务记录暂时不可用';
      } finally {
        historyPending = null;
        if (revision === historyRevision) lastHistoryAt = Date.now();
        else refreshHistory(true);
      }
    })();
    return historyPending;
  }

  function updateTask(task, view) {
    $('studioTaskTitle').textContent = task?.objective || view?.detail || '当前没有本地任务';
    $('studioTaskTitle').title = $('studioTaskTitle').textContent;
    $('studioTaskState').textContent = view?.label || '等待任务记录';
    $('studioCurrentTask').dataset.tone = view?.tone || '';
    const userState = view?.userState || view?.key;
    const working = ['local_running','testing','building','quiet','planning','recovering','active'].includes(userState);
    const attention = Boolean(task && window.assistantState.needsHumanAttention(task)) || ['failed','stalled','suspected_stall'].includes(userState);
    const state = view?.available === false ? 'unknown' : attention ? 'attention' : working ? 'working' : userState === 'waiting_model' ? 'waiting' : userState === 'completed' ? 'completed' : 'idle';
    $('studioCurrentTask').dataset.state = state;
    $('studioTaskGroup').textContent = {working:'进行中',attention:'需要处理',waiting:'等待网页',completed:'本次已完成',unknown:'状态待确认',idle:'当前任务'}[state];
    $('studioCurrentTask').querySelector('img').src = 'icons/' + ({working:'arrow-path.svg',attention:'exclamation-triangle.svg',waiting:'clock.svg'}[state] || 'chat-bubble-left.svg');
    $('studioRecapLabel').textContent = {working:'当前进展',attention:'待处理事项',waiting:'本地步骤已保存',completed:'本次摘要',unknown:'最后已知进展',idle:'本地进展'}[state];
    $('studioTaskNext').textContent = task?.next_step ? '下一步：' + task.next_step : '';
    $('studioTaskNext').hidden = !task?.next_step || task.next_step === task.current_step;
    const steps = (Array.isArray(task?.steps) ? task.steps : []).map((step,index) => ({
      id:String(step?.step_id || step?.id || index), title:typeof step === 'string' ? step : step?.title || step?.text || '',
      status:step?.state || step?.status || 'pending'
    })).filter(step => step.title);
    $('studioTaskPlan').hidden = !steps.length;
    $('studioPlanCount').textContent = steps.filter(step => step.status === 'completed').length + ' / ' + steps.length;
    const revision = JSON.stringify([task?.task_id,steps]);
    if (revision !== planRevision) {
      const previous = new Map(Array.from($('studioPlanSteps').children, row => [row.dataset.stepId,row.dataset.status]));
      const sameTask = $('studioPlanSteps').dataset.taskId === String(task?.task_id || '');
      const rows = steps.map(step => {
        const row = document.createElement('li'); row.dataset.stepId = step.id; row.dataset.status = step.status;
        if (sameTask && previous.has(step.id) && previous.get(step.id) !== step.status) row.className = 'studio-step-changed';
        const mark = document.createElement('input'); mark.type = 'checkbox'; mark.checked = step.status === 'completed'; mark.disabled = true; mark.tabIndex = -1;
        mark.setAttribute('aria-label',step.title);
        const text = document.createElement('span'); text.textContent = step.title;
        const status = document.createElement('small'); status.textContent = {completed:'已完成',running:'进行中',in_progress:'进行中',failed:'失败',cancelled:'已取消',skipped:'已跳过',pending:'待进行'}[step.status] || '待确认';
        row.append(mark,text,status); return row;
      });
      $('studioPlanSteps').replaceChildren(...rows);
      $('studioPlanSteps').dataset.taskId = String(task?.task_id || '');
      planRevision = revision;
    }
    refreshHistory();
  }

  function resizePanel(width) {
    const left = open() ? sidebar.getBoundingClientRect().width : 0;
    const max = Math.min(560, Math.max(280, innerWidth - left - 280));
    panelWidth = Math.max(280, Math.min(max, width));
    document.documentElement.style.setProperty('--shell-panel', panelWidth + 'px');
    $('workbenchResize').setAttribute('aria-valuenow', String(Math.round(panelWidth)));
    $('workbenchResize').setAttribute('aria-valuemax', String(Math.round(max)));
    requestLayout();
  }

  function resizeSidebar(width, remember = false) {
    if (remember) preferredSidebarWidth = Math.max(200, Math.min(420, width));
    sidebarWidth = Math.max(200, Math.min(420, innerWidth - 240, width));
    document.documentElement.style.setProperty('--studio-nav', sidebarWidth + 'px');
    $('studioSidebarResize').setAttribute('aria-valuenow', String(Math.round(sidebarWidth)));
    resizePanel(panelWidth);
    requestLayout();
  }

  function rememberSidebarWidth() {
    document.body.classList.remove('studio-resizing');
    try { localStorage.setItem('studio-sidebar-width', String(preferredSidebarWidth)); } catch {}
  }

  $('collapseSidebar').onclick = () => setSidebar(false, true);
  $('expandSidebar').onclick = () => setSidebar(!open(), true);
  $('studioNewChat').onclick = () => $('homeButton').click();
  $('studioWorkspaceHub').onclick = () => $('workspacePickerButton').click();
  $('studioAdvisors').onclick = () => showTab('advisors');
  $('studioSettings').onclick = () => $('managerButton').click();
  $('studioCurrentTask').onclick = () => showTab('activity');
  $('studioAllHistory').onclick = () => $('openTaskHistoryButton').click();
  $('studioRefreshHistory').onclick = () => refreshHistory(true);
  document.querySelectorAll('[data-studio-tab]').forEach(button => {
    button.onclick = () => selectTab(button.dataset.studioTab);
    button.onkeydown = event => {
      const names = ['activity', 'advisors', 'connections'];
      let index = names.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % names.length;
      else if (event.key === 'ArrowLeft') index = (index + names.length - 1) % names.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = names.length - 1;
      else return;
      event.preventDefault(); selectTab(names[index], true);
    };
  });
  const handle = $('workbenchResize');
  handle.onpointerdown = event => {
    if (event.button !== 0) return;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('studio-resizing');
    resizePanel(innerWidth - event.clientX);
  };
  handle.onpointermove = event => { if (handle.hasPointerCapture(event.pointerId)) resizePanel(innerWidth - event.clientX); };
  handle.onpointerup = handle.onlostpointercapture = () => document.body.classList.remove('studio-resizing');
  handle.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    resizePanel(event.key === 'Home' ? 280 : event.key === 'End' ? 560 : panelWidth + (event.key === 'ArrowLeft' ? 20 : -20));
  };
  const sidebarHandle = $('studioSidebarResize');
  sidebarHandle.onpointerdown = event => {
    if (event.button !== 0) return;
    sidebarHandle.setPointerCapture(event.pointerId);
    document.body.classList.add('studio-resizing');
    resizeSidebar(event.clientX, true);
  };
  sidebarHandle.onpointermove = event => { if (sidebarHandle.hasPointerCapture(event.pointerId)) resizeSidebar(event.clientX, true); };
  sidebarHandle.onpointerup = sidebarHandle.onlostpointercapture = rememberSidebarWidth;
  sidebarHandle.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    resizeSidebar(event.key === 'Home' ? 200 : event.key === 'End' ? 420 : sidebarWidth + (event.key === 'ArrowRight' ? 20 : -20), true);
    rememberSidebarWidth();
  };
  addEventListener('resize', () => {
    resizeSidebar(preferredSidebarWidth);
    if (innerWidth < 1180) setSidebar(false);
    else if (preferredOpen) setSidebar(true);
    resizePanel(panelWidth);
  });
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.key.toLowerCase() === 'b' && !event.shiftKey && !event.altKey) {
      event.preventDefault(); setSidebar(!open(), true);
    }
  });
  window.studioShell = { showTab, selectTab, renderWorkspaces, updateTask, beforeWorkbenchOpen: () => { if (innerWidth < 1180) setSidebar(false); } };
  setSidebar(preferredOpen && innerWidth >= 1180);
  selectTab('activity');
  resizeSidebar(sidebarWidth);
  resizePanel(panelWidth);
  addEventListener('load', () => {
    refreshHistory(true);
    window.browserAssistant.updateStatus?.().then(result => { $('studioVersion').textContent = result?.data?.currentVersion || result?.data?.current || ''; }).catch(() => {});
  });
})();
