(() => {
  const requested = new URLSearchParams(location.search).get('theme');
  const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)');
  function apply(mode, skin) {
    mode = ['light', 'dark', 'black', 'system'].includes(mode) ? mode : 'light';
    const theme = mode === 'system' ? (systemTheme?.matches ? 'dark' : 'light') : mode === 'black' ? 'dark' : mode;
    for (const node of [document.documentElement, document.body]) {
      node.dataset.theme = theme;
      node.dataset.themeMode = mode;
      if (skin !== undefined) node.dataset.skin = skin === 'glass' ? 'glass' : 'classic';
    }
  }
  apply(requested, new URLSearchParams(location.search).get('skin'));
  systemTheme?.addEventListener('change', () => {
    if (document.body.dataset.themeMode === 'system') apply('system');
  });
  const api = window.browserAssistant || window.mcpAssistant || window.workspaceAssistant || window.activityDetail || window.approvalAssistant;
  api?.onThemeChanged?.(apply);
})();
