# 审计前工作树基线登记

日期：2026-09-12
对应执行入口：`docs/EXECUTION_PLAN_2026-09-12.md`
HEAD：`10262075f5d370ab27f7300569273113e8d26ceb`（分支 main）

## 审计前已存在的 Git 可见修改（不得覆盖/清理/回滚）

```text
 M electron/browserPreload.js
 M electron/chatViewController.js
 M electron/main.js
 M electron/services/environmentService.js
 M package-lock.json
 M renderer/browser.js
?? _mcp_verify.err
```

这些修改在审计启动前已存在于工作树。后续安全修复必须在此之上叠加，不得通过 `git checkout` / `git reset` / 删除工作树来“恢复干净状态”。

## 当时版本身份

| 项 | 值 |
|---|---|
| 包名 | `web-mcp-assistant` |
| 桌面版本 | `0.4.5` |
| Runtime 源码版本 | `0.4.9` |
| MCP Schema | v7 / 9 tools |

## 测试基线（审计当轮，非下一版验收）

| 检查 | 结果 | 归因 |
|---|---|---|
| `node --test tests/*.test.js` | 107 项 / 106 pass / 1 fail | `tests/stability-source.test.js:106` 旧断言期待 `completed=30000:120000`；产品已将 `failed` 保留延长为 600000 |
| `node scripts/run-python-tests.js` | unittest 103 项 / 1 error / 其余无失败 | `build_verify.collect_artifacts` 在 Windows 长短路径别名混用时 `relative_to` 抛错 |
| Schema 契约 | 通过 | v7 一致 |
| GUI / 安装包 / 干净 Windows / 新 Tunnel 端到端 | **未验收** | 不得写为通过 |

## 已知产品缺陷（审计发现，修复前不得包装成已解决）

1. 时间胶囊回滚可能 `git checkout HEAD` 撤销任务前已有用户修改，并影响 index。
2. `task:kill-active-command` 使用 `action=terminate` 且缺 `session_id`，失败被吞后仍写 `stopped`。
3. 桌面 pause/resume/stop 直接写 `task-state.json`，绕过 Runtime。
4. `prepare_coding_context` / `workspace_context` 对非默认根仍混入默认 workspace 的 instructions 与 task。
5. `git:commit-and-push` 无条件 `git add -A`。
6. 跨 Runtime 会话的 ContextUsageTracker 基线残留可把新会话调用扣成 0。

## 本登记之后允许的改动边界

- 可在上述 7 个文件上继续修改，但不得删除它们。
- 不得执行 `scripts/check-source-root-clean.js` 中有删除副作用的清理。
- 破坏性 Git/进程控制只允许在临时夹具仓库验证。
- 完整审计中未运行的项目不得凭推断写为通过。
