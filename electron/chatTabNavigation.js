// Runs in the native page. Intercept conversation links before the SPA replaces
// its document; the main process decides whether to reuse or preserve the tab.
function installChatTabNavigation(documentId) {
  window.__mcpTabNavigationDocument = Math.max(window.__mcpTabNavigationDocument || 0, documentId);
  if (window.__mcpTabNavigationHandler) return;
  const handle = (event) => {
    if (event.defaultPrevented || ![0, 1].includes(event.button)) return;
    const link = event.target?.closest?.('a[href]');
    const newChat = event.target?.closest?.('[data-testid="create-new-chat-button"]');
    if (!link && !newChat) return;
    let url;
    try { url = new URL(link?.href || '/', location.href); } catch { return; }
    if (url.protocol !== 'https:' || !['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname)) return;
    if (!(url.pathname === '/' && !url.hash || /(?:^|\/)c\/[^/]+/.test(url.pathname) || /^\/g\/[^/]+\/?$/.test(url.pathname))) return;
    if (window.__mcpTabNavigationBypass === url.href) return;
    const separate = event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey || link?.target === '_blank';
    const visible = node => { const style = getComputedStyle(node); return Boolean(node.getClientRects().length && !node.hidden && style.visibility !== 'hidden' && Number(style.opacity) !== 0); };
    const generating = [...document.querySelectorAll('button[data-testid="stop-button"],button[aria-label="停止"],button[aria-label="停止生成"],button[aria-label="Stop"],button[aria-label*="Stop generating" i],button[aria-label="Stop streaming"]')].some(visible);
    // Keep native same-page actions (e.g. resetting an empty draft) intact.
    if (!separate && !generating && url.href === location.href) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    console.info('[web-mcp-tabs] ' + JSON.stringify({ url: url.href, separate, generating, document_id: window.__mcpTabNavigationDocument }));
  };
  window.__mcpTabNavigationHandler = handle;
  window.addEventListener('click', handle, true);
  window.addEventListener('auxclick', handle, true);
}

module.exports = { installChatTabNavigation };
