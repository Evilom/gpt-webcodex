// Offline development fixture; never submits user text or starts real work.
(() => {
  const query = new URLSearchParams(location.search);
  document.documentElement.dataset.theme = query.get('theme') || 'dark';
  const conversation = document.getElementById('conversation');
  const empty = document.querySelector('.preview-empty');
  if (query.get('conversation') === 'empty') { conversation.hidden = true; empty.hidden = false; }
  const form = document.querySelector('form');
  form.onsubmit = event => {
    event.preventDefault();
    const input = form.querySelector('textarea');
    if (!input.value.trim()) return;
    conversation.hidden = false; empty.hidden = true;
    const question = document.createElement('div');
    question.className = 'preview-question preview-message-new'; question.textContent = input.value.trim();
    const response = document.createElement('p');
    response.className = 'preview-message-new';
    response.textContent = '这是一条离线交互演示。正式应用会在原生 ChatGPT 页面发送消息；这里没有调用模型或执行命令。';
    conversation.append(question, response); input.value = ''; question.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  form.querySelector('textarea').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } };
  const model = document.getElementById('previewModel'), menu = document.getElementById('previewModels');
  model.onclick = () => { menu.hidden = !menu.hidden; model.setAttribute('aria-expanded', String(!menu.hidden)); };
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.hidden = true; model.setAttribute('aria-expanded', 'false'); } });
  document.getElementById('previewAttach').onclick = () => { document.getElementById('previewAttachment').textContent = '恢复方案.md · 示例材料'; };
})();
