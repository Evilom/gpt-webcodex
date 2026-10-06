const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browserAssistant', {
  openManager: () => ipcRenderer.invoke('manager:open'),
  openWorkspaceWindow: () => ipcRenderer.invoke('workspace-window:open'),
  navigate: (action) => ipcRenderer.invoke('chat:navigate', action),
  stopGeneration: () => ipcRenderer.invoke('chat:stop-generation'),
  openLastDownload: () => ipcRenderer.invoke('chat:open-last-download'),
  chatStatus: () => ipcRenderer.invoke('chat:status'),
  openLogin: () => ipcRenderer.invoke('chat:login-open'),
  embeddedLogin: () => ipcRenderer.invoke('chat:login-embedded'),
  dismissLogin: () => ipcRenderer.invoke('chat:login-dismiss'),
  nativeLoginStart: () => ipcRenderer.invoke('chat:native-login-start'),
  nativeLoginFinish: () => ipcRenderer.invoke('chat:native-login-finish'),
  nativeLoginCancel: () => ipcRenderer.invoke('chat:native-login-cancel'),
  lightweightStatus: () => ipcRenderer.invoke('app:lightweight-snapshot'),
  workspaceHub: () => ipcRenderer.invoke('workspace:hub'),
  removeRecentWorkspaces: (targets) => ipcRenderer.invoke('workspace:remove-recent', targets),
  clearActiveWorkspace: () => ipcRenderer.invoke('workspace:clear-active'),
  inspectWorkspaces: () => ipcRenderer.invoke('workspace:inspect'),
  removeWorkspace: (workspace) => ipcRenderer.invoke('workspace:remove', workspace),
  cleanupInvalidWorkspaces: () => ipcRenderer.invoke('workspace:cleanup-invalid'),
  toggleWorkspaceFavorite: (workspace) => ipcRenderer.invoke('workspace:favorite', workspace),
  storageStatus: () => ipcRenderer.invoke('workspace:storage'),
  cleanupStorage: () => ipcRenderer.invoke('workspace:cleanup-storage'),
  switchWorkspace: (workspace) => ipcRenderer.invoke('workspace:switch', workspace),
  chooseAndSwitchWorkspace: () => ipcRenderer.invoke('workspace:choose-and-switch'),
  chooseAuthorizedRoot: () => ipcRenderer.invoke('workspace:choose-authorized-root'),
  approvalList: () => ipcRenderer.invoke('approval:list'),
  openApprovalWindow: () => ipcRenderer.invoke('approval-window:open'),
  onChatState: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:state', wrapped);
    return () => ipcRenderer.removeListener('chat:state', wrapped);
  },
  onHeartbeat: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('runtime:heartbeat', wrapped);
    return () => ipcRenderer.removeListener('runtime:heartbeat', wrapped);
  },
  onTaskEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:task-event', wrapped);
    return () => ipcRenderer.removeListener('chat:task-event', wrapped);
  },
  onDownload: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:download', wrapped);
    return () => ipcRenderer.removeListener('chat:download', wrapped);
  },
  onThemeChanged: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('theme:changed', wrapped);
    return () => ipcRenderer.removeListener('theme:changed', wrapped);
  },
  onWorkspaceChanged: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('workspace:changed', wrapped);
    return () => ipcRenderer.removeListener('workspace:changed', wrapped);
  },
  taskState: () => ipcRenderer.invoke('task-state:read'),
  taskHistory: () => ipcRenderer.invoke('task-state:history'),
  taskRuntime: (options = {}) => ipcRenderer.invoke('mcp:task-runtime', options),
  performanceTrace: () => ipcRenderer.invoke('performance:read'),
  pauseTask: () => ipcRenderer.invoke('task-state:pause'),
  resumeTask: () => ipcRenderer.invoke('task-state:resume'),
  contextUsage: () => ipcRenderer.invoke('context:usage'),
  resetContextUsage: () => ipcRenderer.invoke('context:reset-usage'),
  onContextUsage: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('context:usage-changed', wrapped);
    return () => ipcRenderer.removeListener('context:usage-changed', wrapped);
  },
  readTaskConsole: () => ipcRenderer.invoke('task:read-console'),
  killActiveCommand: () => ipcRenderer.invoke('task:kill-active-command'),
  openWorkspaceInExplorer: (target) => ipcRenderer.invoke('workspace:open-in-explorer', target),
  openWorkspaceInEditor: (target) => ipcRenderer.invoke('workspace:open-in-editor', target),
  showInFolder: (path) => ipcRenderer.invoke('workspace:show-in-folder', path),
  gitFileDiff: (relativePath) => ipcRenderer.invoke('git:file-diff', relativePath),
  gitCommitAndPush: (options) => ipcRenderer.invoke('git:commit-and-push', options),
  generateTaskSnapshot: () => ipcRenderer.invoke('task:generate-snapshot'),
  injectPrompt: (text, autoSend) => ipcRenderer.invoke('chat:inject-prompt', text, autoSend),
  setContentInsets: (insets) => ipcRenderer.invoke('chat:set-content-insets', insets),
  createCheckpoint: (options) => ipcRenderer.invoke('checkpoint:create', options),
  getCheckpointStatus: () => ipcRenderer.invoke('checkpoint:status'),
  rollbackCheckpoint: (options) => ipcRenderer.invoke('checkpoint:rollback', options),
  issueApproval: (payload) => ipcRenderer.invoke('approval:issue', payload),
  consumeApproval: (payload) => ipcRenderer.invoke('approval:consume', payload),
  writeHandoff: (options) => ipcRenderer.invoke('task:write-handoff', options),
  stopTask: () => ipcRenderer.invoke('task-state:stop'),
  activityDetailShow: (options = {}) => ipcRenderer.invoke('activity-detail:show', options),
  activityDetailUpdate: (payload = {}) => ipcRenderer.invoke('activity-detail:update', payload),
  activityDetailHide: () => ipcRenderer.invoke('activity-detail:hide'),
  activityDetailClose: () => ipcRenderer.invoke('activity-detail:close'),
  onActivityDetailState: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('activity-detail:state', wrapped);
    return () => ipcRenderer.removeListener('activity-detail:state', wrapped);
  }
});
