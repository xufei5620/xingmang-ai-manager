# CLI 原生安装器落点（识别用）

首页判断各 CLI 装没装，除 npm 全局目录外还要认出**官方原生安装器**装的那一份。
这份文档记录各安装器的落点出处，供 `electron/tool-installation.ts` 的
`nativeInstallBinDirectories` / `classifyCliInstallDisplaySource` 引用。

> 官方安装脚本域名（`claude.ai`、`chatgpt.com`）在 CI 沙箱里不可达（代理 403），
> 下面的路径来自各自仓库的 issue / PR 与官方文档，逐条给出出处；真机核对以官方脚本为准。

## Claude Code（`@anthropic-ai/claude-code`，命令 `claude`）

原生安装器：`curl -fsSL https://claude.ai/install.sh | bash`（Windows 为
`irm https://claude.ai/install.ps1 | iex`）。

- **启动器落点**
  - macOS / Linux：`~/.local/bin/claude`，是指向 `~/.local/share/claude/versions/` 下
    某个版本的符号链接。
  - Windows：`%USERPROFILE%\.local\bin\claude.exe`。
- **为什么不能只看 PATH**：Windows 原生安装器多次被报告**没把 `%USERPROFILE%\.local\bin`
  写进用户 PATH**，装完 `claude` 在新终端里都找不到。所以主进程即便拿到干净 PATH 也扫不到，
  必须显式探测 `~/.local/bin`。
  - anthropics/claude-code#21365 —「Native Windows installer (install.ps1) does not add
    installation directory to PATH」
  - anthropics/claude-code#86144 —「Windows installer should add
    %USERPROFILE%\.local\bin to the User PATH itself」
  - anthropics/claude-code#42337 —「native installer does not add .local\bin to PATH —
    claude not recognized after successful install」

## Codex CLI（`@openai/codex`，命令 `codex`）

独立安装器：`curl ... | bash`（Windows 为 `irm https://chatgpt.com/codex/install.ps1 | iex`）。

- **启动器落点**：`~/.local/bin/codex`（包装器，用户真正调用的入口）。
- **真实二进制**：`~/.codex/packages/standalone/current`，是指向
  `~/.codex/packages/standalone/releases/<版本>-<目标三元组>/codex` 的符号链接；有守护
  进程自动更新。
  - openai/codex#17022 —「Significantly improve standalone installer」（确立
    `CODEX_HOME/packages/standalone` 结构与 `current` 符号链接）
  - openai/codex#24035 —「codex update uses standalone install.sh path instead of
    detecting npm-managed install」（确认独立安装与 npm 安装是两条并存的通道）

## Grok CLI / Gemini CLI

目前只有 npm 安装通道，没有广泛使用的官方原生安装器，因此不额外列已知落点。
`~/.local/bin` 的通用探测对它们同样生效——真装在那里也能认出来，归类为原生。

## 识别口径

- 探测：`~/.local/bin`（Windows 为 `%USERPROFILE%\.local\bin`）叠加在 PATH 之上一起扫。
- 归类（`classifyCliInstallDisplaySource`）：
  - 命中 npm 全局包目录 → `npm`
  - 落在上面的原生安装器目录 → `native`（首页显示「已安装（官方安装器）」）
  - PATH 上的其他可执行文件 → `path`（首页显示「已安装（其他来源）」）
- 只做识别，不切安装通道；原生 / 其他来源装的那份，首页不给 npm 更新/回滚按钮，改用
  一句被动提示，让用户用它原本的方式更新。名单的推荐 / 阻断判断按版本号照常生效。
