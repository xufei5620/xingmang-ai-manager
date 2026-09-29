## 用户

- 登录后，Codex（桌面端和命令行）、Claude Code、Gemini CLI、Grok 里都会多一个「星芒画图」工具：直接说「画一张……」或「把这张图改成……」，图就出现在对话里，不用再点允许，Codex 里改图也不会再被拦下。

## 开发

- 接手 #667：新增 `xingmang-image` stdio MCP（`bundled-skills/xingmang-ai/scripts/mcp-server.mjs`），支持文生图与改图（`/v1/images/edits`，原图只收绝对路径下的单链接 PNG/JPEG/WebP，按内容判定类型），先用 Codex Key、被拒再换生图分组 Key，上游报错里的 Key 打码。
- 登记改为直接写各家配置（`config-files.ts` 的 `syncXingmangImageMcpConfigs`），不再依赖 `codex mcp add`：Codex/Grok 写 `config.toml`（`tool_timeout_sec = 300`，Codex 只对这一个工具写 `approval_mode = "approve"`），Claude Code 写 `~/.claude.json` 并在 `settings.json` 的 `permissions.allow` 只加这一个工具，Gemini 写 `settings.json`（`timeout` + `trust`）。只写已存在的配置目录；同名但不是本软件写的条目不动；Node 换了位置会自动改指。
- 修掉 #667 原提交里 `test:scripts` 丢掉的 `publish-dl-landing` 与 `dl-landing-install-guide` 两个测试，以及只在 Windows 上成立的路径断言。
