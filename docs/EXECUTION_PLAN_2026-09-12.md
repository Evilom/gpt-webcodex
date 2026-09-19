# mywebgpt 审计后执行计划

日期：2026-09-12。状态：M1 安全阻断项与 M2 可观察/可交接核心已落地；T03a 安全三方回滚、T03b 选择性提交、T01 项目绑定、T02 真停止、T05 控制台增强、T06 交接文件、用量基线修复、T08 文档/资源门禁均已在本轮实现。GUI/安装包/干净 Windows/真实 Tunnel 端到端仍未验收。详见文末「本轮实现状态」。

完整审计报告已随当前会话提供：`mywebgpt_audit_and_roadmap_2026-09-12.md`。本文件为工程内的执行入口，可独立用于派发任务。请先读 `AGENTS.md`。

## 一、实际基线与边界

目标：`E:\projects\mywebgpt`，包名 `web-mcp-assistant`，桌面 0.4.5，Runtime 0.4.9，Schema v7 / 9 tools。

HEAD：`10262075f5d370ab27f7300569273113e8d26ceb`，分支 main。审计对象是当前工作树，不等于 HEAD 或已发布安装包。

审计前后原有 Git 可见修改：

```text
 M electron/browserPreload.js
 M electron/chatViewController.js
 M electron/main.js
 M electron/services/environmentService.js
 M package-lock.json
 M renderer/browser.js
?? _mcp_verify.err
```

这些不是本轮产生的，不得覆盖、清理或回滚。审计没有修改业务源码、启动/停止桌面、重启 Runtime、安装依赖、构建、提交、推送或执行真实回滚。测试使用临时目录，未运行有删除副作用的 source-root-clean 检查。新增本计划文件不代表修复已经完成。

特别注意：MCP 插件默认工作区仍可能是 `E:\game\qijiepai`。所有操作必须显式绑定 mywebgpt；不要把额外授权路径和当前任务归属混为一谈。

## 二、先修四个阻断项

### T01 / P0：跨项目上下文归属

实际复现：明确请求 mywebgpt，prepare 返回 mywebgpt 的源码，却混入启界牌的 instructions 和 task_resume。

定位：`resources/coding-tools-mcp/coding_tools_mcp/server.py:2609,2700–2716,2803`。requested path 已解析，但仍取 `self.project_context` 和 `self.task_state`。

要求：统一 scope/root/instructions/task/run/operation 归属。额外授权根的只读信息可以查询，但不能沿用默认任务；跨根写入须明确绑定或拒绝，不静默切换。以两个不同 AGENTS、不同任务的 A/B 临时项目验收。

### T02 / P0：真实暂停、停止与恢复

定位：`electron/main.js:357–375` 直接写 task-state.json；`510–523` 调 `command_control` 时传 action=terminate、缺 session_id，并吞错返回成功。Runtime 实际只支持 poll/write/kill/read（`server.py:3512–3536`）。

要求：桌面经 Runtime 请求控制，禁止直接修改 Runtime 状态文件代替执行。停止必须定位正确 session，并确认父子进程退出；失败不能显示成功。定义暂停调度、取消命令、停止任务的区别。`runtimeOrchestrator.js:305–316` 中忽略 native.stop 异常后宣称全部停止的路径也一起修复。

验收：临时持续输出父子进程真正停止；错误 session、断连、停止失败可观察；恢复不能盲目重做已完成副作用。

### T03a / P0：安全检查点与变更账本

定位：`electron/main.js:700–758,783–873`。创建只备份当时 modified_files；回滚先删除未跟踪文件或 checkout HEAD；保存的 stashSha 没有用于恢复。可能丢失任务前已有修改并改变 index；有错误仍清空变更记录。备份名有路径扁平化撞名和同任务复用风险。

要求：旧危险回滚在通过验收前保持禁用。基线记录原有 staged/unstaged/untracked、文件存在性及内容 hash；只逆转任务增量；检查点后发生用户修改时进入冲突；保护 index；快照独立 ID；失败逐项保留。优先复用既有 Python Worktree 安全机制，不另写无保护的桌面 Git 路径。

验收：仅在临时 Git 仓库覆盖脏基线、任务新文件、用户后续编辑、重命名、删除、二进制、快照撞名与部分失败；不拿用户工程演示删除或回滚。

### T03b / P0：选择性提交、独立推送

定位：`electron/main.js:628–651` 无条件 git add -A。

要求：改为真实文件/变更选择、staged diff 审查、分支和远端预览。不能夹带任务外文件、不能破坏原 index；commit 与 push 单独确认与报告。与 T03a 共用归属账本。

## 三、随后补齐的可靠性工作

| ID | 工作 | 主要证据/入口 | 验收条件 |
|---|---|---|---|
| T00 | 基线登记、测试修复与契约测试入口 | 下节测试记录；AGENTS | 原改动保留；两项现有失败分别归因，不通过删除保护换全绿 |
| T04 | 统一 IPC/路径校验及一次性审批 | main.js 的 file URL/startsWith/各文件入口；server.py:5573–5616 | exact page + sender/frame + 参数校验；canonical/realpath 边界；一次性授权绑定 scope/task/请求且有到期 |
| T05 | 真实输出控制台、日志和连接诊断 | main.js:377–478；commandRunner.js:23–34；tunnelService.js:60–67,88–90 | output_ref/offset 增量补读；有界缓冲；stdout/stderr 分离；端口可用不冒充远端可用；错误不吞 |
| T06 | 持久化交接与计数修复 | main.js:652–698；browser.js:956–991；contextUsageTracker.js | handoff 文件先保存，明确未验证/失败/下一步；注入发送有确认与降级；跨 session 基线正确 |
| T07 | 生产行为回归、Windows CI、交付回执 | task-console/user-experience-features 测试目前多为字符串匹配 | 测试调用真实模块，临时 Git/index/进程/IPC 场景通过；结果关联代码身份、命令与退出码 |
| T08 | 当前文档与发行资源门禁 | ARCHITECTURE 仍讲旧 Docker；source-bundle 可跳过便携 Python；无 .github/workflows | 分离开发与发行要求；缺必需资源禁止发布；干净 Windows 安装验收；历史审计不冒充当前结果 |

补充安全要求：日志不能只过滤顶层字段（logService.js:30–40）；嵌套/文本/URL 凭据要统一脱敏，导出诊断包可预览。Windows 策略检查不是 OS 沙箱，界面如实说明防护层次；不要用全局 trusted 替代一次性审批。

补充已确认指标缺陷：A Runtime session 累计 32000 字节/10 调用并设置基线，再切 B session 的 3200 字节/1 调用，实际被扣为 0 tokens/0 调用。当前 UI 已标明“MCP 流量估算，不等于 ChatGPT 上下文”，保留此改进；不要重新包装成精确上下文剩余量。

交接按钮当前固定 1.6 秒后自动注入，没确认发送成功就提示已继承任务。改成先落文件、页面检测、用户确认/可观察发送确认、失败明确降级。不要擅自恢复已移除的 DOM Bridge 或会话全量导出。

## 四、本轮实际验证，不是下一版验收

- `node --test tests/*.test.js`：107 项，106 pass / 1 fail。失败在 `tests/stability-source.test.js:106`，旧断言期待 completed=30000，其余=120000；当前 `renderer/browser.js:596` 新增 failed=600000。先确认保留时长规则，再改成行为测试，不机械删掉现有改进。
- `node scripts/run-python-tests.js`：Schema v7 校验通过；unittest 103 项、1 error，其余 102 无失败。`test_task_state_and_build.py` 中产物检查在 `build_verify.py:250` 因 Administrator 与 ADMINI~1 路径别名混用导致 relative_to 抛错。修 collect_artifacts 入口规范化并补别名测试；常规 verify_build 会先 resolve，不能宣称所有构建都必然失败。
- 有 Python 未关闭文件流 ResourceWarning，需定位异常收尾。
- ContextUsageTracker 基线残留已通过纯内存输入复现。
- 未测试 GUI、真实破坏性回滚、干净 Windows 安装、新 Tunnel 端到端、安装包构建、当前 npm audit；不得写为已通过。
- 当前源码不含便携 Python 是开发 checkout 的允许形态，不能据此宣称发行包缺 Python；实际 resources/tools 的 tunnel-client/rg/fd 存在检查通过。发布必须另设强门槛。
- 未执行 `check-source-root-clean.js`；该脚本会递归删除根目录 `%SystemDrive%` 文件夹。检查应只报告，清理必须限本次自建临时目录。

## 五、扩展路线，不抢在安全修复前做

**产品方向：可靠的本地 AI 开发工作台，而非继续堆网页按钮。**

| 阶段 | 范围 | 进入下一阶段的门槛 |
|---|---|---|
| M0 可信基线 | T00，登记原修改，建立生产行为夹具 | 现有失败归因清楚，不污染别的项目 |
| M1 安全可控 | T01/T02/T03a/T03b，T04 的危险入口校验 | 不串工程、不误删、不夹带、真实停得住 |
| M2 可观察可交接 | T05/T06/T07 | 每个任务有真实命令结果、变更和未验证项；无伪成功提示 |
| M3 项目工作台 | T08 + T09 项目档案 | 独立项目权限/指令/测试构建入口/历史；干净环境验收 |
| M4 可扩展执行 | T10 串行任务队列 + T11 配方/产物中心 | 单项目写租约、重启不重复、配方权限可审查、产物有来源/hash |
| 后续可选 | T12 单一新客户端适配、签名/可信更新、额外平台 | 真实需求明确，前述门槛通过；不先做多模型壳 |

T09 项目档案：保存 scope、授权根、默认策略、AGENTS、测试/构建入口、产物与忽略规则；日常界面呈现当前任务、真实输出、变更审查和验收，维护设置留在管理中心。

T10 任务队列：先持久化串行，后考虑隔离并行；queued/running/waiting_user/blocked/failed/completed 明确区分。只持续执行明确提交的本地步骤，不把本地队列说成网页版模型能在关闭会话后无限自主开发。

T11 工作流与产物：先做 Node/Python 的诊断、修复加回归、只读审计和构建配方；额外引擎要真实检测环境。下载先进入项目收件箱，记录 scope/task/来源/hash，确认后归档，不默认弄乱源码根目录。

暂缓：插件商店、重型知识库、云账户/聊天同步、多 Agent 同工作树并发、无人值守无限循环、全仓 UI/语言框架重写。

## 六、实施依赖和多人边界

T00 → T01/T02/T03a；T03a 的归属模型稳定后做 T03b；T01/T02 → T04；T02/T04 → T05；T01/T02/T03a → T06；T07 从 T00 并行建设且每包合入即验收；T08 随 T07 完成；T09 后才进入 T10/T11。

一个人可串行承担多个角色，不要求固定人数。多人时：Runtime 负责人拥有 context/task/process 等模块；桌面负责人拥有薄 IPC/表现接线；Git 安全负责人拥有统一变更账本；QA 负责人拥有临时仓库、进程、Windows、安装和故障夹具。main.js/server.py 由一位集成人控制共享接线，其他人交付独立模块，避免同时改同一大片代码。

建议契约：WorkspaceScope(scope_id,canonical_root,instruction_root,authorized_roots,policy_version)、TaskIdentity(scope_id,task_id,run_id,operation_id,state_version)、CommandRecord(session_id,output_refs,exit_code)、ChangeSet(baseline,files before/after hashes,index state,conflicts)、Handoff/Receipt(完成/失败/未验证/下一步/证据引用)。这些是提案，不是现有 API。

Runtime 是执行状态唯一权威，桌面只请求控制和审批展示。公开 Schema 变更按 AGENTS 升 version 并重新生成 contract；不要让桌面和 Runtime 各自硬编码不一致的枚举。

## 七、交付定义

每包必须提交：问题复现、实际改动范围、生产行为测试、执行命令与退出码、未验证项、Schema 影响、跨项目保护、后续依赖。只能在临时夹具测试删除/回滚/Git/进程控制。

开始前重新核验真实工作区和原变更；认领后只做指定任务，不顺带加功能；保留现有改动，未获得明确授权不提交、不推送、不部署、不清理用户工作树。完整审计中未运行的项目不得凭推断写为通过。

## 八、本轮实现状态（2026-09-12 同日，二次推进）

| 任务 | 状态 | 证据 |
|---|---|---|
| T00 基线与测试 | 已完成 | `docs/BASELINE_PRE_AUDIT_2026-09-12.md`；`keepVisibleMs`；`collect_artifacts` 路径别名；`tests/behavior/` |
| T01 项目身份绑定 | 已完成 | `server.py::_scope_binding` + A/B Python 测试 |
| T02 真停止 | 已完成 | Runtime task_control/command_control kill；orchestrator 不吞 native.stop |
| T03a 安全回滚 | **已实现** | `electron/services/safeCheckpoint.js`：基线账本 + 物理快照 + 冲突检测；**不使用 git checkout HEAD**；行为测试覆盖脏基线/新文件/冲突/预暂存保护 |
| T03b 选择性提交 | 已完成 | `safeGitOps.stageAndCommit` + 临时 Git 行为测试 |
| T04 路径+一次性审批 | **已实现** | 路径边界；`ApprovalStore`；rollback 支持 approvalId/confirm |
| T05 控制台 | **已实现** | `command_control poll/read` 真输出；日志尾部有界读取 |
| T06 交接 | **已实现** | `handoffService` 先写 `.coding-tools/handoff.md`；snapshot 注入不再空口“已继承” |
| ContextUsageTracker 基线 | **已修复** | session 绑定；A 基线不再清零 B |
| T07 行为回归 | 已扩展 | `tests/behavior/*` 共 18 项（提交/回滚/审批/交接/契约） |
| T08 文档与门禁 | **已实现** | `docs/ARCHITECTURE.md` 重写；`scripts/check-release-resources.js`；`docs/RELEASE_CHECKLIST.md` |
| T09–T11 项目档案/队列/产物中心 | 未做 | 需在 M3/M4 单独排期 |

本轮验证：

- `node --test tests/*.test.js tests/behavior/*.test.js` → **126 pass / 0 fail**
- `node scripts/run-python-tests.js` → Schema v7 一致；unittest **106 OK**
- `node scripts/check-release-resources.js` → 开发形态通过（便携 Python 缺失仅 warn）
- 未跑：GUI、安装包、干净 Windows、真实 Tunnel 端到端、`npm audit`、`npm run dist`

原 7 项 Git 可见修改均保留。未提交、未推送。

## 九、下一步建议（M3/M4）

1. GUI 手工回归：安全回滚、真停止、控制台、交接文件。
2. T09 项目档案（授权根/测试入口/产物规则按项目持久化）。
3. T10 串行任务队列（单项目写租约）。
4. T11 产物中心（下载/测试结果/构建产物带 hash）。
5. 干净 Windows + 真实 Tunnel 验收后再谈多客户端。
