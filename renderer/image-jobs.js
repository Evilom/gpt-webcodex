(() => {
  const api = window.browserAssistant;
  const $ = id => document.getElementById(id);
  if (!api.imageJobsStatus) { $('imageJobsStatus').textContent = '当前版本尚未提供生图入口。'; return; }
  let state = { configured: false, enabled: false, jobs: [] };
  let busy = false, wasVisible = false;
  let selectedId = '', offset = 0, filter = 'all';
  let view = 'list';
  try { if (localStorage.getItem('assistant.imageJobsView') === 'grid') view = 'grid'; } catch {}
  const pageSize = () => view === 'grid' ? 4 : 5;
  const list = () => api.imageJobsList({ offset, filter, view, selected_id: selectedId });
  const previewQueue = [];
  let loadingPreviews = 0;
  function drainPreviews() {
    while (loadingPreviews < 2 && previewQueue.length) {
      loadingPreviews++;
      void previewQueue.shift()().finally(() => { loadingPreviews--; drainPreviews(); });
    }
  }
  function preview(card) {
    const image = card.querySelector('.image-job-preview');
    if (busy || card.dataset.status !== 'succeeded' || image.hasAttribute('src') || image.dataset.loading) return;
    image.dataset.loading = 'true';
    previewQueue.push(async () => {
      try {
        if (busy || !card.isConnected || !visible() || !card.open && view !== 'grid') return;
        const response = await api.imageJobsPreview(card.dataset.id);
        if (!response?.ok) throw new Error(response?.error || '小预览暂时不可用');
        image.src = `data:${response.data.mime_type};base64,${response.data.data}`; image.hidden = false;
      } catch (failure) {
        const error = card.querySelector('.image-job-error'); error.textContent = failure.message; error.hidden = false;
        card.querySelector('.image-job-cover').title = failure.message;
        card.querySelector('.image-job-cover>span').textContent = '预览暂不可用';
      } finally { delete image.dataset.loading; }
    });
    drainPreviews();
  }
  const labels = { queued: '等待出图', running: '正在生成', succeeded: '已生成 · 待审核', failed: '生成失败', interrupted: '后台已中断', submission_unknown: '提交状态待确认' };
  function render() {
    $('imageJobsEnabled').checked = state.enabled;
    $('imageJobsEnabled').disabled = busy || !state.configured;
    $('imageJobsImport').disabled = busy;
    $('imageJobsRefresh').disabled = busy || !state.configured;
    $('imageJobsStatus').textContent = !state.configured ? '请导入已部署入口的 integration.json；无需导入账户凭证。'
      : `${state.enabled ? 'AI 生图已启用' : '后续生图已关闭'}${state.total !== undefined ? ` · ${state.active_count} 个进行中${state.unconfirmed_count ? ` · ${state.unconfirmed_count} 个待确认` : ''} · ${state.total} 个任务` : '；可查询进度与资产'}`;
    const container = $('imageJobsList');
    container.dataset.view = selectedId ? 'detail' : view;
    $('imageJobsListView').setAttribute('aria-pressed', String(view === 'list'));
    $('imageJobsGridView').setAttribute('aria-pressed', String(view === 'grid'));
    $('imageJobsListView').disabled = busy;
    $('imageJobsGridView').disabled = busy;
    offset = state.offset ?? offset;
    const selected = state.selected_job?.id === selectedId ? state.selected_job : state.jobs?.find(job => job.id === selectedId);
    const jobs = selectedId ? (selected ? [selected] : []) : state.jobs || [];
    $('imageJobsBack').hidden = !selectedId;
    document.querySelector('.image-jobs-toolbar').hidden = Boolean(selectedId);
    $('imageJobsEmpty').hidden = jobs.length > 0;
    $('imageJobsEmpty').textContent = selectedId ? '该任务暂时不可用，请返回列表刷新。' : filter === 'active' ? '暂无进行中或待确认的任务' : '暂无任务';
    const total = state.filtered_total ?? state.total ?? 0;
    $('imageJobsPager').hidden = Boolean(selectedId) || total <= pageSize();
    $('imageJobsPage').textContent = `${Math.floor(offset / pageSize()) + 1} / ${Math.max(1, Math.ceil(total / pageSize()))}`;
    $('imageJobsPrevious').disabled = busy || offset === 0;
    $('imageJobsNext').disabled = busy || offset + pageSize() >= total;
    $('imageJobsFilter').disabled = busy;
    const ids = new Set(jobs.map(job => job.id));
    for (const item of Array.from(container.children)) if (!ids.has(item.dataset.id)) item.remove();
    jobs.forEach((job, index) => {
      let card = Array.from(container.children).find(item => item.dataset.id === job.id);
      if (!card) {
        card = document.createElement('details'); card.dataset.id = job.id;
        const summary = document.createElement('summary');
        const cover = document.createElement('span'); cover.className = 'image-job-cover';
        const placeholder = document.createElement('span'); cover.append(placeholder);
        const title = document.createElement('span'); title.className = 'image-job-title';
        const status = document.createElement('small'); summary.append(cover, title, status);
        summary.onclick = event => {
          event.preventDefault();
          if (selectedId) return;
          selectedId = job.id; state.selected_job = state.jobs.find(item => item.id === selectedId);
          render(); $('imageJobsBack').focus();
        };
        const body = document.createElement('div'); body.className = 'image-job-body';
        const meta = document.createElement('p'); meta.className = 'image-job-meta';
        const image = document.createElement('img'); image.className = 'image-job-preview'; image.hidden = true;
        const error = document.createElement('p'); error.className = 'image-job-error'; error.hidden = true;
        const actions = document.createElement('div'); actions.className = 'advisory-actions';
        for (const [label, action] of [['打开原图', () => api.imageJobsOpen(job.id)], ['另存原图', () => api.imageJobsSave(job.id)]]) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'shell-button'; button.textContent = label;
          button.onclick = () => void assetAction(action); actions.append(button);
        }
        body.append(meta, image, error, actions); card.append(summary, body);
        card.addEventListener('toggle', () => { if (card.open) preview(card); });
      }
      card.dataset.status = job.status;
      card.open = Boolean(selectedId);
      card.querySelector('.image-job-title').textContent = job.title;
      card.querySelector('summary').title = job.title;
      card.querySelector('summary small').textContent = job.status === 'succeeded' && job.review_status === 'passed' ? '已生成 · 已审核' : job.review_status === 'rejected' ? '已生成 · 审核未通过' : labels[job.status] || job.status;
      card.querySelector('img').alt = `${job.title}的小预览`;
      card.querySelector('.image-job-cover>span').textContent = job.status === 'succeeded' ? '加载小预览…' : labels[job.status] || job.status;
      card.querySelector('.image-job-meta').textContent = `${job.id}${job.created_at ? ' · ' + new Date(job.created_at).toLocaleString() : ''}${job.dimensions ? ' · ' + job.dimensions.join(' × ') : ''}`;
      const error = card.querySelector('.image-job-error');
      const image = card.querySelector('.image-job-preview');
      if (view === 'grid' && !selectedId) card.querySelector('.image-job-cover').append(image);
      else card.querySelector('.image-job-body').insertBefore(image, error);
      error.textContent = job.error || ''; error.hidden = !job.error;
      card.querySelector('.advisory-actions').hidden = job.status !== 'succeeded';
      if (container.children[index] !== card) container.insertBefore(card, container.children[index] || null);
      if (card.open || view === 'grid') preview(card);
    });
    $('imageJobsNote').textContent = selectedId ? '仅加载小预览；原图保留本地，生成完成不代表内容已审核。' : `每页 ${pageSize()} 个任务，进行中的优先。点选查看详情与资产。`;
  }
  async function perform(action, includeJobs = false) {
    if (busy) return;
    busy = true; render();
    try {
      const response = await action();
      if (!response?.ok) throw new Error(response?.error || '生图入口操作失败');
      state = { ...state, ...response.data };
      if (includeJobs && state.configured) {
        const listed = await list();
        if (!listed?.ok) throw new Error(listed?.error || '进度暂时不可用');
        state = { ...state, ...listed.data };
      }
      busy = false; render();
    } catch (failure) { busy = false; render(); $('imageJobsStatus').textContent = failure.message; }
  }
  async function assetAction(action) {
    try { const response = await action(); if (!response?.ok) throw new Error(response?.error || '资产操作失败'); }
    catch (failure) { $('imageJobsStatus').textContent = failure.message; }
  }
  const refresh = () => perform(() => api.imageJobsStatus(), true);
  $('imageJobsImport').onclick = () => perform(() => api.imageJobsImport(), true);
  $('imageJobsRefresh').onclick = refresh;
  $('imageJobsFilter').onchange = event => { filter = event.target.value; offset = 0; state.offset = 0; void refresh(); };
  $('imageJobsPrevious').onclick = () => { offset = Math.max(0, offset - pageSize()); state.offset = offset; void refresh(); };
  $('imageJobsNext').onclick = () => { offset += pageSize(); state.offset = offset; void refresh(); };
  for (const mode of ['list', 'grid']) $(mode === 'list' ? 'imageJobsListView' : 'imageJobsGridView').onclick = () => {
    if (view === mode) return;
    view = mode; offset = Math.floor(offset / pageSize()) * pageSize(); state.offset = offset;
    try { localStorage.setItem('assistant.imageJobsView', view); } catch {}
    void refresh();
  };
  $('imageJobsBack').onclick = () => {
    const previous = selectedId; selectedId = ''; state.selected_job = null; render();
    Array.from($('imageJobsList').children).find(card => card.dataset.id === previous)?.querySelector('summary').focus();
  };
  $('imageJobsEnabled').onchange = event => { const enabled = event.target.checked; void perform(() => api.imageJobsSelect(enabled)); };
  const visible = () => !document.hidden && !$('workbench').hidden && !$('workbench').inert && !$('studioAdvisorsPanel').hidden && !$('imageJobsSection').hidden;
  const onVisibility = () => { const current = visible(); if (current && !wasVisible) void refresh(); wasVisible = current; };
  const observer = new MutationObserver(onVisibility);
  observer.observe($('workbench'), { attributes: true, attributeFilter: ['hidden', 'inert'] });
  observer.observe($('studioAdvisorsPanel'), { attributes: true, attributeFilter: ['hidden'] });
  observer.observe($('imageJobsSection'), { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', onVisibility);
  const timer = setInterval(() => {
    if (visible()) void perform(async () => {
      const status = await api.imageJobsStatus();
      return status?.ok && (state.active_count > 0 || state.unconfirmed_count > 0 || state.last_request_id !== status.data.last_request_id) ? list() : status;
    });
  }, 15000);
  window.addEventListener('pagehide', () => { observer.disconnect(); clearInterval(timer); }, { once: true });
  void perform(() => api.imageJobsStatus()).then(onVisibility);
})();
