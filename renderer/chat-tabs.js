(() => {
  const api = window.browserAssistant;
  const list = document.getElementById('chatTabList');
  const bar = document.getElementById('chatTabsBar');
  const add = document.getElementById('newChatTab');
  const notice = document.getElementById('chatTabNotice');
  const nodes = new Map();
  let tabs = [], active = '';
  const labels = { generating: '正在生成', interrupted: '等待恢复', render_error: '显示异常', renderer_gone: '页面已退出', asset_error: '资源异常' };
  async function act(method, id) {
    try {
      const result = await api[method](id);
      if (result?.ok === false) throw new Error(result.error);
      notice.hidden = true;
    } catch (error) { notice.textContent = error.message; notice.hidden = false; }
  }
  add.onclick = () => act('openChatTab');
  list.addEventListener('wheel', event => {
    if (list.scrollWidth > list.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) { list.scrollLeft += event.deltaY; event.preventDefault(); }
  }, { passive: false });
  list.addEventListener('keydown', event => {
    const index = tabs.findIndex(tab => tab.id === active);
    let next;
    if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
    if (event.key === 'Home') next = tabs[0];
    if (event.key === 'End') next = tabs.at(-1);
    if (next) { event.preventDefault(); void act('selectChatTab', next.id).then(() => nodes.get(next.id)?.select.focus()); }
    if (event.key === 'Delete') { event.preventDefault(); void act('closeChatTab', active); }
  });
  window.chatTabsView = { render(state) {
    if (!Array.isArray(state.tabs) || !api.openChatTab) return;
    const selectionChanged = active !== state.activeTabId;
    bar.hidden = false;
    tabs = state.tabs;
    active = state.activeTabId;
    for (const [id, node] of nodes) if (!tabs.some(tab => tab.id === id)) { node.root.remove(); nodes.delete(id); }
    for (const tab of tabs) {
      let node = nodes.get(tab.id);
      if (!node) {
        const root = document.createElement('div'); root.className = 'chat-tab';
        const select = document.createElement('button'); select.type = 'button'; select.className = 'chat-tab-select'; select.setAttribute('role', 'tab');
        const dot = document.createElement('span'); dot.className = 'chat-tab-dot'; dot.setAttribute('aria-hidden', 'true');
        const title = document.createElement('span'); title.className = 'chat-tab-title';
        const close = document.createElement('button'); close.type = 'button'; close.className = 'chat-tab-close'; close.textContent = '×';
        select.append(dot, title); root.append(select, close); list.append(root);
        select.onclick = () => act('selectChatTab', tab.id);
        root.onauxclick = event => { if (event.button === 1) { event.preventDefault(); void act('closeChatTab', tab.id); } };
        close.onclick = () => act('closeChatTab', tab.id);
        node = { root, select, dot, title, close }; nodes.set(tab.id, node);
      }
      const selected = tab.id === active;
      const label = tab.loading ? '正在加载' : labels[tab.status] || (tab.unread ? '回复已完成' : '就绪');
      node.root.dataset.active = String(selected);
      node.root.dataset.status = tab.loading ? 'loading' : tab.status;
      node.root.dataset.unread = String(tab.unread);
      node.select.setAttribute('aria-selected', String(selected));
      node.select.setAttribute('aria-label', `${tab.title}，${label}`);
      node.select.tabIndex = selected ? 0 : -1;
      node.select.title = `${tab.title} · ${label}`;
      node.title.textContent = tab.title;
      node.close.setAttribute('aria-label', `关闭标签：${tab.title}`);
      node.close.title = tab.protected ? '关闭前会确认，保留其他标签' : '关闭标签';
    }
    add.disabled = tabs.length >= state.maxTabs;
    add.title = add.disabled ? '已保留 8 个标签，请先关闭不用的标签' : '新建对话标签';
    if (selectionChanged) nodes.get(active)?.root.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (state.tabError) { notice.textContent = state.tabError; notice.hidden = false; }
    window.syncChatContentInsets?.();
  } };
})();
