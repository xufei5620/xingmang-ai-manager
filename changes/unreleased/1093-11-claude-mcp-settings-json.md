## 用户

- Claude Code 的扩展页不再把写在 settings.json 里的 MCP 连接列出来：Claude Code 本身不读那里，以前列出来点「移除」也删不掉。

## 开发

- Claude Code 的 MCP 列表不再读 `~/.claude/settings.json` 和项目 `.claude/settings.json` 的 `mcpServers`（#1093 第 11 条）。
  官方设置项里没有这个键，MCP 只存在 `~/.claude.json`（用户层、本项目层）和项目的 `.mcp.json`；2.1.302 实测
  `mcp list`、`mcp get` 都不列这两份，`mcp remove` 不论哪一层都回「No MCP server named …」。以前 `readConfiguredMcpServers`
  把它们算成用户层、项目层，界面给了「移除」却删不掉；同名时后读的 settings.json 还在同一层盖住 `~/.claude.json` 里真正生效的那条，
  列表上显示的启动命令是 settings.json 里那份。现在只读 CLI 自己读的两处，两份 settings.json 原样不动。Gemini 那支不变。
