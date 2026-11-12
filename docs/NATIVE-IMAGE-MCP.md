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
- 只写已存在的配置目录；Codex 用官方 ChatGPT 登录时不新登记（它有原生画图），但从星芒配置整份带过来的那条、存着的两份 Codex 配置（`xingmang-config-relay.toml`、`xingmang-config-chatgpt.toml`）里登记过的那条，每次同步跟着换位置，不然切换以后找不到脚本。
- 同名条目只有「启动的是星芒技能目录（`images`，或改名前的 `星芒AI`）下 `scripts/mcp-server.mjs`」才算本软件的，才会改写；别的一律不动。
- 服务器条目（Codex / Grok 的 `[mcp_servers.xingmang-image]`、Claude Code 与 Gemini 的 `mcpServers.xingmang-image`）里的调用时限、免确认和 `enabled = true` 只在第一次登记时写。登记过的条目以后每次只对齐启动方式（`command`、`args`、`env` 里的 `XINGMANG_IMAGE_CONFIG_PATH`，Claude Code 另加 `type = "stdio"`），跟着 Node 或技能目录换位置；别的键照用户现在的样子留着，缺了也不补。关掉（`enabled = false`）、改成每次先问（Codex `approval_mode = "prompt"`、Gemini `trust: false` 或删掉 `trust`）、改时限、自己加的 `disabled_tools` / `excludeTools` / 环境变量都算用户的选择。画一张图要扣余额，以前每次登录同步都整条重建，改成先问的人下次打开星芒又变回不问就画。
- Claude Code 的免确认不在服务器条目里，是 `settings.json` 里 `permissions.allow` 的一条规则，每次同步缺了照旧补上。要 Claude Code 每次先问，就把 `mcp__xingmang-image__generate_image` 写进 `permissions.ask`：写进 ask / deny 的本软件一律不碰，而 2.1.277 判断权限时 ask 规则排在免确认模式（`bypassPermissions`）前面，开着免确认模式也会问（读程序确认，没在真机上演过）。只从 `allow` 里删掉那条不够：免确认模式下本来就不问，别的模式下下次同步又会补回来。
- 工具说明和 `SKILL.md` 都让 AI 优先用这个工具，技能脚本留作没有工具时的兜底。

## 用哪个模型

默认只用 OpenAI 的 gpt-image 系列。登录同步时（`syncXingmangAiSkill`）主进程拿技能的两把 Key 各查一次 `GET /v1/models`，合起来按 `XINGMANG_AI_IMAGE_MODEL_PREFERENCE`（`gpt-image-2.6-flare` → `gpt-image-2.5-flare` → `gpt-image-2`）再 `XINGMANG_AI_IMAGE_MODEL_FALLBACKS`（`gpt-image-2.6-sunburst` → `gpt-image-2.5-sunburst`）的顺序，把账号列表里有的排成一串：第一个写进 `config.json` 的 `model`，后面的写进 `fallbackModels`（可以是空数组）。两把都没查到、或查到了但一个都没有，就两样都不写，画图照旧用 `gpt-image-2`，日志记一句。sunburst 慢、偏精修，flare 和 `gpt-image-2` 在时不当默认。`gpt-image-1` 官方已经下了，`gpt-image-1.5` 站上调不通，都不挑，点名也在本地拒掉。AI 对话的图片默认（`chat/state.ts` 的 `DEFAULT_IMAGE_MODELS`）和图片分组次序（`ai-chat-protocol.ts` 的 `IMAGE_GROUP_MODEL_ORDER`）跟这串同一个顺序，测试钉住。

画图工具把 `model` 当默认值（`tools/list` 的 schema 默认值跟着它走）。AI 没点名、或点的就是这个默认值时，中转明确回了错误（没渠道、没定价这类）会按 `fallbackModels` 依次换下一个再试，只换账号列表里有的；连不上、超时不换。老版本写的 `config.json` 没有 `fallbackModels`，照旧只换回 `gpt-image-2`。AI 点名要别的型号就只用那个。

Nano Banana（`nano-banana-2` / `gemini-3.1-flash-image`、`nano-banana-pro`）和 Grok（`grok-imagine-image` 系列）只在点名时用，只用图片模型分组那把 Key（GPT 分组没有这些模型，没有那把 Key 就直接提示登录或开通，不发请求）。Nano Banana 走 Gemini 原生接口 `POST /v1beta/models/{model}:generateContent`（站上 Gemini 渠道走 Images API 会回 500「only imagen models are supported」），鉴权头用 `x-goog-api-key`（2026-11-11 实测它和 `Bearer` 站上都认），尺寸用 `imageConfig.imageSize`（1K/2K/4K）加 `aspectRatio`，图从 `candidates[].content.parts[].inlineData` 取，改图时参考图放进 `parts`。Grok 走 `/v1/images/generations`（改图 `/v1/images/edits`），要 `response_format: b64_json`；实测只出 1280x720，传 `aspect_ratio` 也不变，所以不传尺寸。两家回的都是 JPEG。

认型号三处用同一套规则（主进程 `OPENAI_IMAGE_MODEL_PATTERN` / `GEMINI_IMAGE_MODEL_PATTERN` / `GROK_IMAGE_MODEL_PATTERN`、`mcp-server.mjs`、技能脚本 `generate.mjs`，测试钉住一致）；`config.json` 的默认模型只收 `gpt-image-*`。以前画图工具只认写死的 5 个，站上新出的型号会被悄悄换回 `gpt-image-2`（#1059）。工具 schema 的 `model` 不列枚举，只给默认值和一句说明；点名认不出的型号时，报错里列出能用的型号。

尺寸两边一样：`size` 可以写宽x高，也可以写 1K/2K/4K 配 `aspect`（16:9、9:16、1:1、4:3、3:4、3:2、2:3）。gpt-image 系列换成比例不变、都是 16 倍数、总像素在 655,360 到 8,294,400 之间的宽高，长边 1024 / 2048 / 3840（2K 16:9 = 2048x1152，4K 16:9 = 3840x2160，4K 1:1 顶格是 2880x2880，1K 16:9 = 1280x720）。默认画质 `high`：站上各画质同价，2026-11-11 实测 `gpt-image-2.6-flare` 三档各 3 张，low 平均 25.9 秒、medium 27.5 秒、high 24.4 秒。

## 安全边界

- Key 不写进任何工具的配置，只通过环境变量 `XINGMANG_IMAGE_CONFIG_PATH` 告诉脚本 `config.json` 在哪；脚本先用 Codex Key，401/403/429/503 时换生图分组 Key。上游报错里的 `sk-…`、`Bearer …` 打码。
- 只连 `https://xm.solov.cc` / `https://api.solov.cc` / `https://xm-direct.solov.cc` 的 `/v1/images/generations`、`/v1/images/edits` 与 Nano Banana 的 `/v1beta/models/{model}:generateContent`，拒绝重定向，300 秒超时（管到读完响应体），响应 32MB 上限，模型只收上面三套规则认得出的。
- 改图读取的原图：必须是绝对路径、单个普通文件（拒符号链接，lstat 与 fstat 同一文件）、不超过 20MB、按文件头判定为 PNG/JPEG/WebP，最多 4 张。被提示词注入要求「改一下 ~/.ssh/id_rsa」时，内容校验会拒绝上传。
- 退出账号只清 Key，工具条目保留；调用时会提示重新登录，不会用旧凭据。

## 待真机确认

- Codex 桌面端第一次调用是否还会弹「允许吗」（源码 `mcp_tool_call.rs` 里 `approve` 直接跳过确认，但桌面端的自动审核有没有另一道没实测）。
- 没装 Node 的电脑：登记会跳过并在日志里写「这台电脑上没有找到 Node.js」，工具不会出现。
- Grok 调 MCP 工具时是否要确认。
