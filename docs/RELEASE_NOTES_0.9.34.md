# 超级智囊团 0.9.34

修复 OpenAI tunnel-client 0.0.16 使用 MCP 2026-07-28 探测本地 Runtime 时返回 HTTP 400 的问题。包含 0.9.33 的仓库索引读写优化。

- 支持请求通过 `params._meta` 声明 MCP 2026-07-28，直接执行 `server/discover`、`tools/list` 和 `tools/call`，不再因版本识别失败而退回旧握手。
- 校验 `MCP-Protocol-Version`、`Mcp-Method` 和工具调用的 `Mcp-Name` 与请求正文一致，并为现代协议补齐 `resultType`、服务身份和私有缓存字段。
- 保留桌面内部使用的 discovery 格式、旧版 `initialize` 握手和 HTTP Session 恢复行为；新协议请求复用本地 Runtime，不创建额外 HTTP Session。
- 保留 0.9.33 的路径到 FTS rowid 映射、每 128 项分批提交、300 秒索引过期阈值及各工作区的后台索引策略。升级不会重置已有索引或工作区设置。
- Windows 便携 Python 安装依赖时禁用字节码编译；发行资源统一排除 `__pycache__` 和 `.pyc`，安装包校验同时检查缓存与协议源码一致性。
- 桌面与 Runtime 版本同步为 0.9.34；公共工具 Schema 仍为 v16、12 个工具。

已用真实 `tunnel-client dev proxy` 验证新协议 discovery、工具列表和工具调用，并确认旧握手仍可用。真实 ChatGPT 网页与 OpenAI 线上通道的验收需要更新安装后在原使用环境中完成。
