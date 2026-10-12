(() => {
  const api = window.browserAssistant || window.mcpAssistant;
  const button = document.getElementById('updateAction');
  const check = document.getElementById('checkUpdate');
  const message = document.getElementById('updateStatus');
  let state = {};
  const unwrap = (result) => { if (!result?.ok) throw new Error(result?.error || '更新操作失败'); return result.data; };
  const render = (value) => {
    if (!value) return;
    state = value;
    const labels = {
      idle: '启动后自动检查，每 6 小时再次检查', checking: '正在检查我们自己的 GitHub Release…',
      current: `已是最新版 ${value.current}`, unpublished: '暂未发布正式版本',
      available: `新版 ${value.latest} 可下载`, downloading: `正在下载 ${value.progress || 0}%`,
      downloaded: `新版 ${value.latest} 已下载，完成任务后可安装`, error: `更新检查或下载失败：${value.error}`
    };
    if (message) message.textContent = labels[value.stage] || '';
    const actionable = ['available', 'downloading', 'downloaded'].includes(value.stage);
    if (button) {
      button.hidden = !actionable;
      button.disabled = value.stage === 'downloading';
      button.textContent = value.stage === 'downloaded' ? '安装更新' : value.stage === 'downloading' ? `下载 ${value.progress || 0}%` : value.manual ? `获取 ${value.latest}` : `下载 ${value.latest}`;
      button.title = '更新只来自 Evilom/gpt-webcodex；安装由你决定时机';
    }
    if (check) check.disabled = ['checking', 'downloading'].includes(value.stage);
  };
  const perform = async (action) => {
    try { const result = unwrap(await action()); if (result?.stage) render(result); }
    catch (error) { if (message) message.textContent = error.message; else if (button) button.title = error.message; }
  };
  check?.addEventListener('click', () => void perform(() => api.checkUpdate()));
  button?.addEventListener('click', () => {
    if (state.stage === 'downloaded') {
      if (window.confirm('安装更新会退出并重新打开助手。请先完成当前任务；通道配置、工作区和登录状态会保留。')) void perform(() => api.installUpdate());
    } else void perform(() => api.downloadUpdate());
  });
  api.onUpdate?.(render);
  void perform(() => api.updateStatus());
})();
