## 用户

- 从星芒打开 Claude Code 时，文件夹里已经带着 Claude Code 自己的设置文件的（多半是网上下载来的项目），不再替你答「信任这个文件夹」，由 Claude Code 自己问一次，免得项目里写好的自动执行命令一打开就在你电脑上跑起来；空文件夹和你自己的新项目照旧不问。

## 开发

- D4（0.2.24 深查 `安全.md` 新-1，yoyo 11-10「按照你的推荐做」）：打开 Claude Code 前，`provider-launch-service.ts` 的
  `workspaceCarriesClaudeProjectSettings` 依次 lstat 工作目录里的 `.claude/settings.json`、`.claude/settings.local.json`、`.mcp.json`
  （名单在 `workspace-guard.ts` 的 `claudeProjectSettingsFiles`），有任何一份、或看不了（除 ENOENT / ENOTDIR 以外的错）就给
  `trustManagedWorkspace` 传 `leaveFolderTrustToCli`：`~/.claude.json` 里不写这个文件夹的 `hasTrustDialogAccepted`、不建空项目条目，
  `hasCompletedOnboarding` 照旧补。日志记 `workspace.trust.left-to-cli`，这种情况下不再记 `workspace.trust.written`。
  以前写下的信任不回收；Codex、Grok 不受影响，已下线的 Gemini 那一支照旧。说明见 `docs/WORKSPACE-TRUST.md`。
