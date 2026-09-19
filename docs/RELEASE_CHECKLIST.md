# 发布检查清单

## 开发态自动门禁（可本地跑）

- [x] `node scripts/check-release-resources.js`（必需资源与 Schema 契约；不删文件）
- [x] `node --test tests/*.test.js tests/behavior/*.test.js`
- [x] `node scripts/run-python-tests.js`（含 Schema 契约）
- [x] `node scripts/check-schema-contract.py`

## 人工/外部条件（未完成不得写“已通过”）

- [ ] Windows 代码签名
- [ ] 全新 Windows 用户账户安装 + 启动验收
- [ ] 使用真实新 Tunnel 完成 ChatGPT 连接端到端
- [ ] GUI 手工回归：暂停/继续/停止、控制台真输出、安全回滚、选择性提交
- [ ] `npm audit --omit=dev`（本轮未跑）
- [ ] `npm run dist` 安装包构建（本轮未跑）

## 特别注意

- `scripts/check-source-root-clean.js` 会删除源码根下的 `%SystemDrive%` 临时目录；**发行检查不要把它当只读门禁**。清理必须限本次自建临时目录。
- 开发 checkout 缺少便携 Python 是允许形态；安装包资源校验必须单独确认。
- 历史 Docker 模式文档已作废，见 `docs/ARCHITECTURE.md`。
