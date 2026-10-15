# 第三方软件声明

本程序集成并管理 **Coding Tools MCP**。

- Project: Coding Tools MCP
- Author: Coding Tools MCP Contributors
- Source: https://github.com/xyTom/coding-tools-mcp
- License: Apache License 2.0

发行包内 `resources/coding-tools-mcp/LICENSE` 与 `NOTICE` 保留了上游许可和声明。

本程序可能调用用户电脑中已经安装的 Python、Git 与其他开发工具；这些外部工具不随本程序分发，其许可由各自项目提供。

Apple Silicon Mac 发行包还内置以下运行组件：

- CPython 3.12.10（Python Software Foundation License），通过 https://github.com/astral-sh/python-build-standalone 的 20250409 发行版提供；发行树中的第三方许可文件保留在 Python 目录。
- OpenAI Tunnel Client 0.0.16（Apache License 2.0），https://github.com/openai/tunnel-client 。
- ripgrep 14.1.1（MIT / Unlicense），https://github.com/BurntSushi/ripgrep 。
- fd 10.2.0（MIT / Apache License 2.0），https://github.com/sharkdp/fd 。

Mac 构建产物附带 runtime-manifest.json，记录组件下载来源、固定版本和归档 SHA-256。

界面图标使用 Heroicons 2.2.0（MIT），来源 https://github.com/tailwindlabs/heroicons 。许可保存在 `renderer/icons/LICENSE`。


## 独立对话渲染实验

使用 assistant-ui（MIT）：@assistant-ui/react 0.15.28、@assistant-ui/react-markdown 0.14.22。Claude 示例的消息组件组合按自有主题与只读数据适配器调整；来源固定为 https://github.com/assistant-ui/assistant-ui/tree/523d86ea12300d73f8bb0859c8228f88f8cd0f80 。未集成其云服务或模型后端。

构建时自动收集本次渲染包使用的第三方模块及完整许可证，随发行包保存在 renderer/chat-dist/THIRD_PARTY_LICENSES.txt（包括 Markdown、HTML 净化与转换及公式依赖）。KaTeX 公式字体保持原样，按 SIL Open Font License 1.1 分发；从字体元数据保留的版权和保留字体名声明、完整 OFL 许可同时保存在 renderer/chat-dist/KaTeX_FONT_LICENSE.txt。assistant-ui 示例保留的许可如下：

MIT License

Copyright (c) 2026 AgentbaseAI Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
