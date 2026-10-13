(() => {
  const api = window.browserAssistant;
  const $ = (id) => document.getElementById(id);
  let state = { configured: false, models: [], selected: [], job: null };
  let busy = false;
  let renderedJobId = '';
  const terminal = new Set(['completed', 'partial', 'failed', 'interrupted']);
  const statusLabels = { preparing: 'AI 正在检查辅助输入预算', submitting: '提交结果待确认，保留原任务', queued: 'AI 辅助咨询排队中', running: '辅助模型正在回答', completed: 'AI 辅助咨询已完成', partial: '部分模型已返回', failed: '辅助咨询失败', interrupted: '辅助咨询已中断' };
  function render() {
    const focusedModel = document.activeElement?.closest('#extensionProviders input')?.value;
    $('advisoryImport').disabled = busy;
    $('advisoryRefresh').disabled = busy || !state.configured;
    $('advisoryResult').hidden = !state.job;
    $('advisoryResult').disabled = busy;
    const models = state.models.length ? state.models : [{ id: 'anthropic::claude-opus-5-5', name: '太极 · Opus 5.5' }, { id: 'google::gemini-3.8-flash-high', name: 'AntiGravity · Gemini 3.8 Flash High' }];
    $('extensionProviders').replaceChildren();
    const others = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '其他辅助模型';
    others.append(summary);
    const preferred = new Set(['anthropic::claude-opus-5-5', 'google::gemini-3.8-flash-high']);
    for (const model of models) {
      const label = document.createElement('label');
      label.className = 'extension-row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = model.id;
      input.checked = state.selected.includes(model.id);
      input.disabled = busy || !state.configured || !state.models.length;
      label.append(input, document.createTextNode(model.name));
      const detail = document.createElement('small');
      detail.textContent = state.models.length ? model.id : '读取服务目录后可启用';
      label.append(detail);
      input.onchange = async () => {
        const selected = Array.from($('extensionProviders').querySelectorAll('input:checked'), (item) => item.value);
        await perform(() => api.advisorySelect(selected));
      };
      (preferred.has(model.id) ? $('extensionProviders') : others).append(label);
    }
    if (others.children.length > 1) $('extensionProviders').append(others);
    if (focusedModel) {
      const input = Array.from($('extensionProviders').querySelectorAll('input')).find((item) => item.value === focusedModel);
      if (input) { if (!preferred.has(focusedModel)) others.open = true; input.focus(); }
    }
    $('advisoryStatus').textContent = state.job ? `${statusLabels[state.job.status] || state.job.status} · ${state.job.id}${state.job.error ? ' · ' + state.job.error : ''}` : state.configured ? state.selected.length ? 'AI 辅助已启用；主 AI 按需发起咨询。' : '已配置；勾选模型以允许主 AI 使用辅助。' : '未配置；请导入现有服务的客户端 JSON。';
  }
  async function perform(action, result = false) {
    if (busy) return;
    busy = true;
    render();
    try {
      const response = await action();
      if (!response?.ok) throw new Error(response?.error || '辅助服务操作失败');
      if (result) {
        const job = response.data;
        renderedJobId = job.id;
        $('advisoryAnswers').replaceChildren();
        for (const item of job.responses || []) {
          const article = document.createElement('article');
          const title = document.createElement('h3');
          title.textContent = item.model || item.model_id || '辅助模型';
          const answer = document.createElement('p');
          answer.textContent = item.answer || item.error?.message || item.error || '暂无结果';
          article.append(title, answer);
          $('advisoryAnswers').append(article);
        }
        state.job = { ...(state.job || {}), id: job.id, status: job.status };
        const fresh = await api.advisoryStatus();
        if (fresh?.ok) state = fresh.data;
      } else state = response.data;
      busy = false;
      render();
    } catch (error) {
      busy = false;
      // Re-read a persisted request ID: a timeout must never trigger a second submission.
      try { const fresh = await api.advisoryStatus(); if (fresh?.ok) state = fresh.data; } catch {}
      render();
      $('advisoryStatus').textContent = `${error.message}${state.job ? '；已保留原任务，请查询。' : ''}`;
    }
  }
  $('advisoryImport').onclick = () => perform(() => api.advisoryImport());
  $('advisoryRefresh').onclick = () => perform(() => api.advisoryModels());
  $('advisoryResult').onclick = () => perform(() => api.advisoryResult(), true);
  if (api.advisoryStatus) {
    void perform(async () => {
      const status = await api.advisoryStatus();
      return status?.data?.configured ? api.advisoryModels() : status;
    });
    setInterval(async () => {
      if (busy || document.hidden) return;
      await perform(() => api.advisoryStatus());
      if (state.job && (state.job.id !== renderedJobId || !terminal.has(state.job.status))) await perform(() => api.advisoryResult(), true);
    }, 15000);
  }
  else { render(); $('advisoryStatus').textContent = '当前运行版本尚未提供扩展接口。'; }
})();
