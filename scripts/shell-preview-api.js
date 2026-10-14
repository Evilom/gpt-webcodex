// Isolated design fixture. No real IPC, services, credentials or model calls.
(() => {
  const listeners = {};
  const ok = (data = {}) => Promise.resolve({ ok: true, data });
  const query = new URLSearchParams(location.search);
  const theme = query.get('theme') || 'dark';
  document.body.dataset.theme = theme;
  document.documentElement.dataset.theme = theme;
  const chat = { url: 'https://chatgpt.com/c/design-preview', canGoBack: false, canGoForward: false, loading: false, streamState: { status: query.get('scenario') === 'interrupted' ? 'interrupted' : 'completed', updatedAt: Date.now() }, login: { status: 'idle', prompt: false }, nativeLogin: { status: 'idle' } };
  const runtime = { mcpRunning: true, tunnelRunning: true, connectionRunning: query.get('scenario') !== 'tunnel', schemaIdentity: { version: '0.9.9', schemaVersion: 14, schemaHash: 'preview', toolCount: 10 } };
  let advisory = { configured: true, baseUrl: 'https://demo.invalid', selected: [], models: [], job: null };
  const models = [{ id: 'anthropic::claude-opus-5-5', name: '太极 · Opus 5.5' }, { id: 'google::gemini-4-argon', name: 'AntiGravity · Gemini Argon 4' }, { id: 'google::gemini-3.8-flash-high', name: 'AntiGravity · Gemini 3.8 Flash High' }];
  window.browserAssistant = new Proxy({
    chatStatus: () => ok(chat),
    lightweightStatus: () => ok(runtime),
    workspaceHub: () => ok({ activeWorkspace: 'E:\\projects', workspaces: [{ path: 'E:\\projects' }, { path: 'E:\\robot-sim' }] }),
    taskRuntime: () => ok({ state: null, operations: [], activity: {}, runtime_layers: { process: { state: 'idle' }, execution: { state: 'idle' } } }),
    taskState: () => ok({ state: null }),
    taskHistory: () => ok({ history: [] }),
    approvalList: () => ok({ pending: [] }),
    getCheckpointStatus: () => ok({ hasCapsule: false, canRollback: false }),
    contextUsage: () => ok({ totalTokens: 238600, totalBytes: 954400, callCount: 32 }),
    updateStatus: () => ok({ stage: 'current', current: '0.9.9' }),
    checkUpdate: () => ok({ stage: 'current', current: '0.9.9' }),
    readTaskConsole: () => ok({ lines: [], output: '[设计预览] 没有连接正在运行的本地任务。' }),
    advisoryStatus: () => ok(advisory),
    advisoryImport: () => ok(advisory),
    advisoryModels: () => { advisory.models = models; return ok(advisory); },
    advisorySelect: (selected) => { advisory.selected = selected; return ok(advisory); },
    advisoryResult: () => ok({ ...advisory.job, responses: [{ model: advisory.selected[0], answer: '这是模拟辅助意见。' }] }),
    setContentInsets: (insets) => {
      const frame = document.getElementById('previewChat');
      if (frame) {
        frame.style.top = `${insets.toolbarHeight + insets.top}px`;
        frame.style.right = `${insets.right}px`;
        frame.style.bottom = `${insets.bottom}px`;
        frame.style.width = `calc(100% - ${insets.right}px)`;
        frame.style.height = `calc(100% - ${insets.toolbarHeight + insets.top + insets.bottom}px)`;
      }
      return ok(true);
    }
  }, { get: (target, name) => target[name] || (String(name).startsWith('on') ? (listener) => { listeners[name] = listener; return () => {}; } : () => ok({})) });
  addEventListener('load', () => {
    if (query.get('workbench') === '1') document.getElementById('workbenchToggle').click();
    listeners.onDownload?.({ status: 'completed', path: 'E:\\projects\\研究方案初稿.docx', totalBytes: 28672 });
  });
})();
