## 开发

- WorkBuddy、Claude Desktop、OpenCode 的「打开」不再进安装队列（AGENTS.md I11 登记例外）：
  `external-client-runtime.ts` 的 `launch` 只等同一家正在装的那一次，点安装前已经在打开的，
  安装等它交给资源管理器再动手，两边都只等先来的那一次。以前装着 Claude Code 点 Claude Desktop
  要等它装完，首页别的「打开」也一起变灰（yoyo 2026-10-16 真机，0.2.18 起就这样）。
  首页那一行只在等它自己安装时才说在等谁（`clientLaunchWaitLabel`）。命令行工具和 Codex 桌面端的
  「打开」照旧排队。
