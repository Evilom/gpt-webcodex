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
- OpenAI Tunnel Client 0.0.10（Apache License 2.0），https://github.com/openai/tunnel-client 。
- ripgrep 14.1.1（MIT / Unlicense），https://github.com/BurntSushi/ripgrep 。
- fd 10.2.0（MIT / Apache License 2.0），https://github.com/sharkdp/fd 。

Mac 构建产物附带 runtime-manifest.json，记录组件下载来源、固定版本和归档 SHA-256。
