(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.shellPresentation = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  function describe(chat = {}, runtime = null, stream = {}) {
    const pageFailed = Boolean(chat.error || ['interrupted', 'disconnected', 'error'].includes(stream.status));
    const page = { tone: pageFailed ? 'warning' : chat.loading ? 'pending' : chat.url ? 'ready' : 'pending', label: pageFailed ? '等待恢复' : chat.loading ? '加载中' : chat.url ? '正常' : '等待确认' };
    const mcp = { tone: !runtime ? 'pending' : runtime.mcpRunning ? 'ready' : 'warning', label: !runtime ? '等待确认' : runtime.mcpRunning ? '正常' : runtime.recovering ? '恢复中' : '未就绪' };
    const connected = runtime?.connectionRunning === true;
    const tunnel = { tone: !runtime ? 'pending' : connected ? 'ready' : 'warning', label: !runtime ? '等待确认' : connected ? '正常' : runtime.tunnelRunning ? '上游不可达' : '未连接' };
    let incident = null;
    if (pageFailed) incident = { layer: 'page', message: '网页连接异常，正在等待恢复', detail: chat.error || (runtime?.mcpRunning ? '本地工具继续运行；已生成的文件仍保留。' : '请查看连接详情，确认各层状态。'), canRecover: true };
    else if (runtime && !runtime.mcpRunning) incident = { layer: 'mcp', message: runtime.recovering ? '本地工具正在恢复' : '本地工具未就绪', detail: '网页会话保留；可在设置中查看服务状态。', canRecover: false };
    else if (runtime && !connected) incident = { layer: 'tunnel', message: runtime.tunnelRunning ? 'Tunnel 已启动，上游连接尚未就绪' : 'Tunnel 尚未连接', detail: '本地工具状态独立检查；恢复网页不会修复通道。', canRecover: false };
    const tone = [page, mcp, tunnel].some((item) => item.tone === 'warning') ? 'warning' : [page, mcp, tunnel].every((item) => item.tone === 'ready') ? 'ready' : 'pending';
    return { page, mcp, tunnel, incident, tone, label: tone === 'ready' ? '连接正常' : tone === 'warning' ? '连接异常' : '正在确认' };
  }
  return { describe };
});
