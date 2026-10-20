// Isolated design fixture. No real IPC, services, credentials or model calls.
(() => {
  const listeners = {};
  const ok = (data = {}) => Promise.resolve({ ok: true, data });
  const query = new URLSearchParams(location.search);
  let theme = query.get('theme') || 'dark';
  const design = query.get('scenario') === 'design';
  let activeWorkspace = 'E:\\projects';
  const workspaces = [{ path: 'E:\\projects' }, { path: 'E:\\robot-sim' }];
  function dialog(title, text, actions = []) {
    const previous = document.getElementById('previewDemoDialog');
    previous?.remove();
    const modal = document.createElement('dialog');
    modal.id = 'previewDemoDialog'; modal.className = 'studio-preview-dialog';
    const heading = document.createElement('h1'); heading.textContent = title;
    const note = document.createElement('p'); note.textContent = text;
    const buttons = document.createElement('div');
    for (const [label, action] of actions) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'shell-button'; button.textContent = label;
      button.onclick = () => { action(); modal.close(); };
      buttons.append(button);
    }
    const close = document.createElement('button'); close.type = 'button'; close.className = 'shell-button'; close.textContent = '关闭'; close.onclick = () => modal.close();
    buttons.append(close); modal.append(heading, note, buttons); document.body.append(modal); modal.showModal();
    return ok(true);
  }
  function themePreview(mode) {
    theme = mode;
    for (const node of [document.documentElement, document.body]) {
      node.dataset.theme = mode === 'black' ? 'dark' : mode; node.dataset.themeMode = mode;
    }
    const frame = document.getElementById('previewChat');
    if (frame.contentDocument?.documentElement) frame.contentDocument.documentElement.dataset.theme = mode;
    if (frame.contentDocument?.documentElement) frame.contentDocument.documentElement.dataset.nativeTheme = mode;
    previewAppearance();
  }
  function skinPreview(skin) {
    for(const node of [document.documentElement,document.body])node.dataset.skin=skin;
  }
  const task = { task_id: 'offline-design', objective: '完善长任务中断与恢复方案', status: 'waiting', lifecycle_state:'waiting_model', updated_at: new Date().toISOString(), current_step: '核对连接与执行边界', next_step:'由主 AI 复核并汇总方案', current_command: null,
    steps:[{id:'inspect',title:'核对网页与本地执行状态',state:'completed'},{id:'recover',title:'验证连接恢复与任务续接',state:'completed'},{id:'review',title:'整理辅助意见与检查结果',state:'completed'},{id:'deliver',title:'由主 AI 复核并汇总方案',state:'pending'}] };
  function demoPhase(phase) {
    const stages = {
      running:{status:'active',lifecycle_state:'planning',current_step:'核对连接恢复与续接边界',next_step:'整理辅助意见与检查结果',done:1},
      waiting:{status:'waiting',lifecycle_state:'waiting_model',current_step:'本地验证结束，等待网页主 AI 复核',next_step:'由主 AI 复核并汇总方案',done:3},
      attention:{status:'paused',lifecycle_state:'waiting_user',current_step:'方案已整理，等待确认下一步',next_step:'核对交付方案并确认下一步',done:3},
      completed:{status:'completed',lifecycle_state:'completed',current_step:'恢复方案与验证记录已整理完成',next_step:'',done:4},
      stopped:{status:'stopped',lifecycle_state:'cancelled',current_step:'示例任务已停止',next_step:'',done:1}
    };
    const selected = stages[phase] || stages.waiting;
    Object.assign(task,{status:selected.status,lifecycle_state:selected.lifecycle_state,current_step:selected.current_step,next_step:selected.next_step,updated_at:new Date().toISOString()});
    task.steps.forEach((step,index)=>{step.state=index<selected.done?'completed':phase==='running'&&index===selected.done?'running':'pending';});
    listeners.onTaskEvent?.();
  }
  demoPhase(query.get('phase') || 'waiting');
  const history = [{ objective: '核对附件下载与保存链路', status: 'completed' }, { objective: '统一活动详情的视觉样式', status: 'completed' }, { objective: '接入 Opus 与 Gemini 辅助', status: 'completed' }];
  for (const node of [document.documentElement, document.body]) {
    node.dataset.theme = theme === 'black' ? 'dark' : theme; node.dataset.themeMode = theme;
  }
  const chat = { url: 'https://chatgpt.com/c/design-preview', canGoBack: false, canGoForward: false, loading: false, streamState: { status: query.get('scenario') === 'interrupted' ? 'interrupted' : 'completed', updatedAt: Date.now() }, login: { status: 'idle', prompt: false }, nativeLogin: { status: 'idle' } };
  chat.appearance = { enabled:query.get('claudeChat')==='1',active:false,message:'使用原生 ChatGPT 外观' };
  chat.activeTabId = 'preview-1'; chat.maxTabs = 8;
  chat.tabs = [{ id: 'preview-1', title: '当前对话', url: chat.url, active: true, status: chat.streamState.status },
    { id: 'preview-2', title: '后台生成中的对话', url: 'https://chatgpt.com/c/background-preview', active: false, status: 'generating', protected: true }];
  function previewAppearance() {
    const frame=document.getElementById('previewChat');
    const apply=frame?.contentWindow?.thinkTankChatAppearance;
    const result=apply?.({enabled:chat.appearance.enabled,theme:theme==='system'?'dark':theme,url:frame.contentWindow.location.href});
    chat.appearance.active=Boolean(result?.active);
    chat.appearance.message=!chat.appearance.enabled?'使用原生 ChatGPT 外观':chat.appearance.active?'Claude 对话外观已应用；使用原网页数据':'实验外观已开启；网页就绪后应用，不匹配时显示原生布局';
    listeners.onChatState?.(chat);
    return ok(chat);
  }
  const runtime = { mcpRunning: true, tunnelRunning: true, connectionRunning: query.get('scenario') !== 'tunnel', schemaIdentity: { version: '0.9.9', schemaVersion: 14, schemaHash: 'preview', toolCount: 10 } };
  let advisory = { configured: true, baseUrl: 'https://demo.invalid', selected: design ? ['anthropic::claude-opus-5-5','google::gemini-4-argon'] : [], models: [], job: null };
  const models = [{ id: 'anthropic::claude-opus-5-5', name: '太极 · Opus 5.5' }, { id: 'google::gemini-4-argon', name: 'AntiGravity · Gemini Argon 4' }, { id: 'google::gemini-3.8-flash-high', name: 'AntiGravity · Gemini 3.8 Flash High' }];
  window.browserAssistant = new Proxy({
    chatStatus: () => ok(chat),
    openChatTab: () => { const id='preview-'+(chat.tabs.length+1);chat.tabs.push({id,title:'新对话',url:'https://chatgpt.com/',status:'healthy'});chat.activeTabId=id;listeners.onChatState?.(chat);return ok(chat); },
    selectChatTab: id => { chat.activeTabId=id;listeners.onChatState?.(chat);return ok(chat); },
    closeChatTab: id => { chat.tabs=chat.tabs.filter(tab=>tab.id!==id);chat.activeTabId=chat.tabs[0]?.id;listeners.onChatState?.(chat);return ok(chat); },
    setChatAppearance: (enabled) => { chat.appearance.enabled=enabled;return previewAppearance(); },
    onDownload:listener=>{listeners.onDownload=listener;return ()=>{delete listeners.onDownload;};},
    lightweightStatus: () => ok(runtime),
    workspaceHub: () => ok({ activeWorkspace, workspaces }),
    switchWorkspace: (path) => { activeWorkspace = path; return ok({ activeWorkspace, workspaces }); },
    navigate: (action) => {
      const frame = document.getElementById('previewChat');
      if (action === 'home') {
        const url = new URL(frame.src); url.searchParams.set('conversation', 'empty'); url.searchParams.set('theme', theme); frame.src = url.href;
      } else if (action === 'reload' || action === 'recover') frame.contentWindow.location.reload();
      return ok(true);
    },
    openWorkspaceWindow: () => dialog('工作区', '这是隔离预览。切换只改变示例工作区，不会操作磁盘或重启服务。', workspaces.map(item => [item.path, () => document.dispatchEvent(new CustomEvent('studio-workspace-select', { detail: item.path }))])),
    openManager: () => dialog('设置与连接', '正式桌面版会打开完整管理中心。这里可以切换预览主题；本机配置保持原样。', [['浅色', () => themePreview('light')], ['深灰', () => themePreview('dark')], ['纯黑', () => themePreview('black')],['经典皮肤',()=>skinPreview('classic')],['液态玻璃',()=>skinPreview('glass')]]),
    activityDetailShow: () => dialog('活动详情 · 离线演示', '可切换下列示例状态，观察侧栏、执行计划和摘要的变化。所有记录均为模拟内容，不会启动命令或调用模型。', [['模拟执行',()=>demoPhase('running')],['等待网页',()=>demoPhase('waiting')],['需要处理',()=>demoPhase('attention')],['模拟完成',()=>demoPhase('completed')]]),
    stopTask: () => { demoPhase('stopped'); return ok(true); },
    openLastDownload: () => dialog('附件已保存', '这是预览中的示例附件。正式桌面版会打开已保存的真实文件。'),
    taskRuntime: () => ok({ state: design ? task : null, operations: [], activity: {}, runtime_layers: { process: { state: 'idle' }, execution: { state: 'idle' } } }),
    taskState: () => ok({ state: null }),
    taskHistory: () => ok({ items: design ? history : [] }),
    approvalList: () => ok({ pending: [] }),
    getCheckpointStatus: () => ok({ hasCapsule: false, canRollback: false }),
    contextUsage: () => ok({ totalTokens: 238600, totalBytes: 954400, callCount: 32 }),
    updateStatus: () => ok({ stage: 'current', current: '0.9.22' }),
    checkUpdate: () => ok({ stage: 'current', current: '0.9.22' }),
    readTaskConsole: () => ok({ lines: [], output: '[设计预览] 没有连接正在运行的本地任务。' }),
    advisoryStatus: () => ok(advisory),
    imageJobsStatus: () => ok({ configured: false, enabled: false, last_request_id: '' }),
    imageJobsList: () => ok({ configured: false, enabled: false, jobs: [], total: 0, active_count: 0 }),
    imageJobsImport: () => ok({ configured: false, enabled: false }),
    advisoryImport: () => ok(advisory),
    advisoryModels: () => { advisory.models = models; return ok(advisory); },
    advisorySelect: (selected) => { advisory.selected = selected; return ok(advisory); },
    advisoryResult: () => ok({ ...advisory.job, responses: [{ model: advisory.selected[0], answer: '这是模拟辅助意见。' }] }),
    nativeShellPopover: Boolean(window.nativePopoverPreview),
    setShellPopover: payload => window.nativePopoverPreview?.update(payload),
    onShellPopover: listener => window.nativePopoverPreview?.onEvent(listener),
    setContentInsets: (insets) => {
      void window.nativePopoverPreview?.insets(insets);
      const frame = document.getElementById('previewChat');
      if (frame) {
        frame.style.top = `${insets.toolbarHeight + insets.top}px`;
        frame.style.right = `${insets.right}px`;
        frame.style.left = `${insets.left || 0}px`;
        frame.style.bottom = `${insets.bottom}px`;
        frame.style.width = `calc(100% - ${insets.right + (insets.left || 0)}px)`;
        frame.style.height = `calc(100% - ${insets.toolbarHeight + insets.top + insets.bottom}px)`;
      }
      return ok(true);
    }
  }, { get: (target, name) => name in target ? target[name] : (String(name).startsWith('on') ? (listener) => { listeners[name] = listener; return () => {}; } : () => ok({})) });
  addEventListener('load', () => {
    document.getElementById('previewChat').addEventListener('load',previewAppearance);
    previewAppearance();
    if (query.get('workbench') === '1') document.getElementById('workbenchToggle').click();
    if (query.get('panel')) window.studioShell.showTab(query.get('panel'));
    listeners.onDownload?.({ status: 'completed', path: 'E:\\projects\\研究方案初稿.docx', totalBytes: 28672 });
  });
})();
