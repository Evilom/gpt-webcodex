(() => {
  const api = window.browserAssistant;
  const $ = id => document.getElementById(id);
  let current = {}, busy = false, tabId = '', contextKey = '';
  function render(state) {
    const key = `${state.activeTabId || ''}:${String(state.url || '').match(/(?:^|\/)c\/([^/]+)/)?.[1] || ''}`;
    const changedTab = contextKey !== key;
    contextKey = key;
    current = state;
    tabId = state.activeTabId;
    const goal = state.goal;
    const running = goal?.status === 'running';
    const labels = { running: '进行中', paused: '已暂停', completed: '模型报告完成', stopped: '已结束' };
    $('goalModeBadge').textContent = goal ? `${labels[goal.status] || '待确认'} · ${goal.rounds}/${goal.maxRounds}` : '未开启';
    $('goalModeStatus').textContent = goal?.reason || '每个会话独立保存，默认关闭。';
    $('goalModeButton').dataset.running = String(running);
    $('goalModeButton').title = goal ? `${labels[goal.status]}：${goal.objective}` : '设置当前会话目标与自动接续';
    if (changedTab || document.activeElement !== $('goalObjective') && goal) $('goalObjective').value = goal?.objective || '';
    if (changedTab || document.activeElement !== $('goalMaxRounds') && goal) $('goalMaxRounds').value = goal?.maxRounds || 10;
    const locked = running || goal?.status === 'paused';
    $('goalObjective').disabled = locked || busy;
    $('goalMaxRounds').disabled = locked || busy;
    $('goalStart').hidden = Boolean(goal && ['running', 'paused'].includes(goal.status));
    $('goalPause').hidden = !running;
    $('goalResume').hidden = goal?.status !== 'paused';
    $('goalStop').hidden = !goal || !['running', 'paused'].includes(goal.status);
    for (const id of ['goalStart', 'goalPause', 'goalResume', 'goalStop']) $(id).disabled = busy;
  }
  async function act(action) {
    if (busy) return;
    const options = { tabId, objective: $('goalObjective').value, maxRounds: Number($('goalMaxRounds').value) };
    busy = true; render(current);
    try {
      const result = await api.goalControl(action, options);
      if (result?.ok === false) throw new Error(result.error);
      const status = await api.chatStatus();
      render(status?.data || status);
    } catch (error) { $('goalModeStatus').textContent = error.message; }
    finally { busy = false; for (const id of ['goalStart', 'goalPause', 'goalResume', 'goalStop']) $(id).disabled = false; const locked = ['running', 'paused'].includes(current.goal?.status); $('goalObjective').disabled = locked; $('goalMaxRounds').disabled = locked; }
  }
  $('goalModeButton').onclick = () => {
    window.studioShell.showTab('activity');
    $('goalModeDetails').open = true;
    if (!$('goalObjective').disabled) $('goalObjective').focus();
  };
  for (const [id, action] of [['goalStart', 'start'], ['goalPause', 'pause'], ['goalResume', 'resume'], ['goalStop', 'stop']]) $(id).onclick = () => void act(action);
  window.goalModeView = { render };
  api.chatStatus().then(result => render(result?.data || result)).catch(() => {});
})();
