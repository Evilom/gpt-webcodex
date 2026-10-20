window.syncChatContentInsets = () => window.browserAssistant.setContentInsets({ toolbarHeight: document.querySelector('.browser-toolbar').getBoundingClientRect().height, bottom: 36 });
window.browserAssistant.onChatState(window.chatTabsView.render);
window.browserAssistant.chatStatus().then(result => window.chatTabsView.render(result.data));
