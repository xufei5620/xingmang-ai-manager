# 星芒画图工具（xingmang-image MCP）

## 为什么不是原生画图

Codex 自带的 `image_gen.imagegen` 只对 ChatGPT 登录开放：`codex-rs/core/src/tools/spec_plan.rs` 的 `image_generation_available` 要求 `requires_openai_auth` **且** `AuthManager::current_auth_uses_codex_backend`，星芒写给客户的是 API Key，从 0.156.1 到上游最新都过不了这道门（2026-09-29 读 rust-v0.156.1 / v0.159.1 源码核实）。绕开只能伪造 ChatGPT 登录，不做。Claude Code 本身不出图。

原来的生图技能是让 AI 在终端里跑 `node generate.mjs`，这条命令受 Codex 沙箱管：星芒给 Codex 写的是 `sandbox_mode = "workspace-write"`、不放行联网，所以在 Codex 里画图或改图会被断网或自动审核拦下。

## 现在怎么做

登录同步后，星芒把同一个 stdio MCP 服务器 `xingmang-image` 写进四家工具的配置。MCP 服务器由工具本身在命令沙箱之外启动，不需要放宽沙箱：

| 工具 | 写到哪里 | 调用时限 | 免确认 |
|---|---|---|---|
| Codex（桌面端与命令行共用） | `$CODEX_HOME/config.toml` 的 `[mcp_servers.xingmang-image]` | `tool_timeout_sec = 300` | `[mcp_servers.xingmang-image.tools.generate_image] approval_mode = "approve"` |
| Claude Code | `~/.claude.json` 的 `mcpServers` | 缺省即可 | `~/.claude/settings.json` 的 `permissions.allow` 加 `mcp__xingmang-image__generate_image` |
| Gemini CLI | `~/.gemini/settings.json` 的 `mcpServers` | `timeout = 300000` | `trust = true`（只作用于这一个服务器） |
| Grok | `~/.grok/config.toml` 的 `[mcp_servers.xingmang-image]` | `tool_timeout_sec = 300` | 未找到对应配置，待真机 |

- 直接写文件，不调各家 `mcp add`：只装了 Codex 桌面端的客户没有命令行版，照样能用。写入走 `executeFilePlans`（两阶段提交 + 备份 + 回滚）。
- 只写已存在的配置目录；Codex 用官方 ChatGPT 登录时不写（它有原生画图）。
- 同名条目只有「启动的是 星芒AI 技能目录下 `scripts/mcp-server.mjs`」才算本软件的，才会改写；别的一律不动。
- 服务器条目（Codex / Grok 的 `[mcp_servers.xingmang-image]`、Claude Code 与 Gemini 的 `mcpServers.xingmang-image`）里的调用时限、免确认和 `enabled = true` 只在第一次登记时写。登记过的条目以后每次只对齐启动方式（`command`、`args`、`env` 里的 `XINGMANG_IMAGE_CONFIG_PATH`，Claude Code 另加 `type = "stdio"`），跟着 Node 或技能目录换位置；别的键照用户现在的样子留着，缺了也不补。关掉（`enabled = false`）、改成每次先问（Codex `approval_mode = "prompt"`、Gemini `trust: false` 或删掉 `trust`）、改时限、自己加的 `disabled_tools` / `excludeTools` / 环境变量都算用户的选择。画一张图要扣余额，以前每次登录同步都整条重建，改成先问的人下次打开星芒又变回不问就画。
- Claude Code 的免确认不在服务器条目里，是 `settings.json` 里 `permissions.allow` 的一条规则，每次同步缺了照旧补上。要 Claude Code 每次先问，就把 `mcp__xingmang-image__generate_image` 写进 `permissions.ask`：写进 ask / deny 的本软件一律不碰，而 2.1.277 判断权限时 ask 规则排在免确认模式（`bypassPermissions`）前面，开着免确认模式也会问（读程序确认，没在真机上演过）。只从 `allow` 里删掉那条不够：免确认模式下本来就不问，别的模式下下次同步又会补回来。
- 工具说明和 `SKILL.md` 都让 AI 优先用这个工具，技能脚本留作没有工具时的兜底。

## 安全边界

- Key 不写进任何工具的配置，只通过环境变量 `XINGMANG_IMAGE_CONFIG_PATH` 告诉脚本 `config.json` 在哪；脚本先用 Codex Key，401/403/429/503 时换生图分组 Key。上游报错里的 `sk-…`、`Bearer …` 打码。
- 只连 `https://xm.solov.cc` / `https://api.solov.cc` 的 `/v1/images/generations` 与 `/v1/images/edits`，拒绝重定向，300 秒超时，响应 32MB 上限，模型白名单。
- 改图读取的原图：必须是绝对路径、单个普通文件（拒符号链接，lstat 与 fstat 同一文件）、不超过 20MB、按文件头判定为 PNG/JPEG/WebP，最多 4 张。被提示词注入要求「改一下 ~/.ssh/id_rsa」时，内容校验会拒绝上传。
- 退出账号只清 Key，工具条目保留；调用时会提示重新登录，不会用旧凭据。

## 待真机确认

- Codex 桌面端第一次调用是否还会弹「允许吗」（源码 `mcp_tool_call.rs` 里 `approve` 直接跳过确认，但桌面端的自动审核有没有另一道没实测）。
- 没装 Node 的电脑：登记会跳过并在日志里写「这台电脑上没有找到 Node.js」，工具不会出现。
- Grok 调 MCP 工具时是否要确认。
