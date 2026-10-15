// Presentation only. Never copy, replace, serialize or submit conversation data.
(function (root) {
  function applyChatAppearanceDocument({ enabled, theme, url }) {
    if (location.href !== url) return { active:false, supported:false };
    const html = document.documentElement;
    const supported = Boolean(document.querySelector('main') && document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"]'));
    if (enabled) {
      html.setAttribute('data-thinktank-chat','claude');
      html.setAttribute('data-thinktank-chat-theme',['light','dark','black'].includes(theme) ? theme : 'dark');
    } else {
      html.removeAttribute('data-thinktank-chat');
      html.removeAttribute('data-thinktank-chat-theme');
    }
    return { active:Boolean(enabled && supported), supported };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { applyChatAppearanceDocument };
  else root.thinkTankChatAppearance = applyChatAppearanceDocument;
})(globalThis);
