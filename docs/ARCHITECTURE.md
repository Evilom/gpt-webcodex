# 网页 MCP 助手架构（当前）

> 历史 Docker 隔离方案已从产品路径移除。当前唯一部署模式是：**便携/系统 Python 驱动的本地 Coding Tools MCP Runtime + OpenAI Tunnel**。
> 审计基线与执行计划见 `docs/EXECUTION_PLAN_2026-09-12.md`、`docs/BASELINE_PRE_AUDIT_2026-09-12.md`。

## 进程边界

```text
Renderer（无 Node 权限）
  ↓ contextBridge / allowlisted IPC（仅本地 renderer 页面）
Electron Main
  ├─ SettingsStore：非敏感配置
  ├─ SecretStore：Windows safeStorage / DPAPI
  ├─ RuntimeOrchestrator：启动/停止/恢复状态机
  ├─ NativeService：Coding Tools MCP Python Runtime
  ├─ TunnelService：OpenAI Tunnel（本地健康端口 ≠ 远端已验证）
  ├─ safeGitOps / safeCheckpoint：选择性提交与安全基线回滚
  ├─ ApprovalStore：危险动作一次性授权
  ├─ handoffService：交接文件落盘
  └─ LogService：脱敏诊断日志
Coding Tools MCP Runtime（Python）
  ├─ WorkspaceScope / TaskStateStore（.coding-tools/task-state.json）
  ├─ WorktreeManager：任务隔离 worktree
  ├─ command_control（poll/write/kill/read）与进程组终止
  └─ Schema v7 公开工具面
```

渲染进程启用 `contextIsolation`、关闭 `nodeIntegration` 并启用沙箱。IPC 校验来源必须是本机 `renderer/` 下页面；路径类入口使用工作区边界校验，禁止 `startsWith` 前缀误匹配。

## 权威边界（必须遵守）

- **Runtime 是任务执行状态的唯一权威。** 桌面 pause/resume/stop/kill 只能发请求，不能直接改 `task-state.json` 伪装成功。
- 桌面只负责：发起请求、展示审批、写交接文件、做 Git 选择性提交与安全基线回滚。
- 公开 Schema 变更（工具名/参数/枚举/默认值）必须提升 `TOOL_SCHEMA_VERSION` 并跑 `scripts/check-schema-contract.py --write`。

## 安全检查点（T03a）

- 创建：记录任务前 **脏文件基线**（存在性 + sha256 + 物理副本），不写 index。
- 回滚：只逆转任务相关路径；未记入基线/任务列表的用户修改保留；检查点后人工改动且不在任务列表 → **冲突跳过**。
- **禁止** 使用 `git checkout HEAD -- file` 或整仓 `git reset` 作为恢复手段。
- 干净于基线的已跟踪文件可用 `git checkout-index -- <path>` 单路径恢复；任务新建未跟踪文件删除。

## 选择性提交（T03b）

- 只 `git add -- <selected>` + `git commit -m msg -- <selected>`（pathspec）。
- 禁止 `git add -A`。commit 与 push 分离。

## 项目身份绑定（T01）

- `workspace_context` / `prepare_coding_context` 按 **解析后的目标根** 绑定 instructions 与 task。
- 授权根 B 不得继承默认 workspace A 的 task/objective。

## 控制台（T05）

- 活动命令优先 `command_control poll/read` 拉真实 stdout/stderr。
- MCP 日志只读尾部有界字节，避免整文件反复读取。

## 交接（T06）

- `task:generate-snapshot` / `task:write-handoff` **先写** `.coding-tools/handoff.md`，再允许提示词注入。
- 交接内容含：目标、步骤、修改文件、Git 状态、失败命令、未验证项、下一步、证据。

## 用量估算

- 顶部计数是 **MCP 流量估算**，不等于 ChatGPT 上下文剩余量。
- `ContextUsageTracker` 基线绑定 session id；跨 session 不得用 A 的基线把 B 扣成 0。

## 发布

- 开发 checkout 不含便携 Python 是允许形态；发布包必须另过资源门禁与干净 Windows 验收。
- 不把「开发环境测试通过」写成「安装包已在干净机器验证」。
