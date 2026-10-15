// App-owned workspace navigation. ChatGPT and running services keep their own lifecycle.
(() => {
  const $ = (id) => document.getElementById(id);
  let panelWidth = 340;
  let tab = 'activity';
  let planRevision = '';
  const requestLayout = () => document.dispatchEvent(new Event('studio-layout'));

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
    selectTab(name);
    if ($('workbench').hidden || $('workbench').inert) $('workbenchToggle').click();
  }

  function updateTask(task, view) {
    const userState = view?.userState || view?.key;
    const working = ['local_running','testing','building','quiet','planning','recovering','active'].includes(userState);
    const attention = Boolean(task && window.assistantState.needsHumanAttention(task)) || ['failed','stalled','suspected_stall'].includes(userState);
    const state = view?.available === false ? 'unknown' : attention ? 'attention' : working ? 'working' : userState === 'waiting_model' ? 'waiting' : userState === 'completed' ? 'completed' : 'idle';
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
  }

  function resizePanel(width) {
    const max = Math.min(560, Math.max(280, innerWidth - 280));
    panelWidth = Math.max(280, Math.min(max, width));
    document.documentElement.style.setProperty('--shell-panel', panelWidth + 'px');
    $('workbenchResize').setAttribute('aria-valuenow', String(Math.round(panelWidth)));
    $('workbenchResize').setAttribute('aria-valuemax', String(Math.round(max)));
    requestLayout();
  }

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
  addEventListener('resize', () => resizePanel(panelWidth));
  window.studioShell = { showTab, selectTab, updateTask };
  selectTab('activity');
  resizePanel(panelWidth);
})();
