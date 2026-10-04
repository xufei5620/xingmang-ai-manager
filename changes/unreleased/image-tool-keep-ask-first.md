## 用户

- 在 Codex、Gemini CLI 里把星芒画图工具改成「画之前先问一句」的，以后打开星芒不会再被改回「不问就画」，
  对它改过的其他设置也一样留着。

## 开发

- #834 核实 F05：`xingmang-ai-mcp.ts` 以前每次登录同步（已登录时每次打开星芒的账号恢复、首页「重新同步」都会走
  `account:sync-managed-cli-keys`）都整条重建 `xingmang-image`。Codex / Grok 只认用户的 `enabled = false`，Codex 的
  `tools.generate_image.approval_mode` 改回 `approve`，`disabled_tools`、`startup_timeout_sec`、自加的环境变量全丢；
  Gemini 改回 `trust: true`，`excludeTools` 丢。画一张图要扣余额，改成先问的人每次打开都变回不问就画。
- 现在默认值（`enabled`、`tool_timeout_sec` / Gemini `timeout`、Codex 的 `approve`、Gemini 的 `trust`）只在第一次登记时写；
  登记过的条目每次只对齐启动方式：`command`、`args`、`env.XINGMANG_IMAGE_CONFIG_PATH`（env 里别的变量保留），Claude Code
  另对齐 `type = "stdio"`。其余键原样保留，缺了也不补：这一套默认值从 #679 第一次上线起没变过，已有条目里缺的只会是用户删的，
  或者 Codex 自己改写条目时省掉的 `enabled = true`。
- Claude Code 的免确认是 `settings.json` 里 `permissions.allow` 的一条规则，缺了照旧每次补上，这次没改。要它先问得写进
  `permissions.ask`：写进 ask / deny 的本来就不碰，2.1.277 判断权限时 ask 规则排在 `bypassPermissions` 前面，免确认模式下也会问
  （读程序确认）。只从 allow 里删掉那条，在非免确认模式下下次同步会补回来，这一点留着没改，`docs/NATIVE-IMAGE-MCP.md` 写明了。
