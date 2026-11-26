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
- 工具说明和 `SKILL.md` 都让 AI 优先用这个工具，技能脚本留作没有工具时的兜底。`SKILL.md` 写明它在各家的完整名字（Codex 里是 `mcp__xingmang_image__generate_image`，Claude Code 里是 `mcp__xingmang-image__generate_image`）和找法：Codex 桌面端的 MCP 工具不在 AI 直接看得到的列表里，要先按 `xingmang` 在 `ALL_TOOLS` 里搜一次（0.2.25，画图优化需求 A2）。
- 用哪份 Node 启动（`xingmang-ai-mcp.ts` 的 `resolveXingmangImageNodeExecutable`，0.2.25，A1）：先找电脑上自己装的（含首页「运行环境」装的）；没有再看 Codex 桌面端自带的那份，`~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/` 下的 `bin/node`（Windows 上 `bin\node.exe`、`node.exe` 两处都试）；都没有才报「这台电脑上没有找到 Node.js」。**不拿本软件自己的程序当 Node 用**：发布包里 RunAsNode 是关着的（`electron-builder.config.cjs` 的 `electronFuses`），开着就等于谁都能拿签过名的本软件跑任意脚本。
- 什么时候登记：登录同步时，以及已登录时每次打开本软件恢复登录时（渲染层 `useAccountBootstrap` 的 `restore` 也会调 `account:sync-managed-cli-keys`，一路走到 `syncImageMcp`）。登录以后才装的 Codex，重新打开本软件就会补上。卸载本软件时不清这条登记：技能文件和它的配置卸载后也留着，登记照样能用。

## 画好以后交回什么（0.2.25，C1）

以前把整张原图以 base64 放进工具结果（单张中位 3.5MB，最大 21MB）。两个后果：

- 新版 Codex 桌面端（0.171 起，桌面端 26.1123.11515 上实测）把约 1MB 以上的图片显示成 `"data":"iVBORw0K…"` 这样的 JSON 原文，不再显示成图。同一位客户、同一个版本：852–928KB 的 3 张正常显示，1335–1701KB 的 8 张全是 JSON；AI 处理结果的代码两次一样。近 45 天画图工具每天返回的图超过 1.3MB 的占 80–100%，所以几乎所有在 Codex 桌面端画图的客户都会碰到。老版本怎么显示没法直接证实（界面代码不公开）。
- 图进了对话历史，之后每一轮都要重新上传；画图多的用户单次请求到了 30–72MB。

现在（`mcp-server.mjs` 的 `finishedContent`）：

- **原图存成文件**。当前目录是个工作目录时放它下面的 `outputs/`；不是时（盘符根、用户主目录本身、主目录下的 `.codex` / `AppData` / `Library` 这类软件数据目录、系统目录、程序安装目录）放系统图片文件夹里的「星芒AI」目录（`~/Pictures`，Windows 开了 OneDrive 备份时是 OneDrive 下的 `Pictures` 或 `图片`）；都写不进去再退到系统临时目录。文件名 `年月日-时分秒-型号.扩展名`，同名的加 `-2`、`-3`，用 `wx` 方式打开，**绝不覆盖已有文件**；目标位置被链接或文件占着就换下一个位置，不顺着链接写出去。保存位置只由脚本决定，工具没有 `out` 参数：它在命令沙箱外面运行，收路径就等于给了 AI 一个在沙箱外任意位置写文件的口子。三处都存不进去时原图照旧放在结果里（图已经画好、钱已经扣了，不能丢）。
- **结果里只放一张小预览**（`scripts/image-preview.mjs`，不带任何依赖，只用 Node 自带的 zlib）：最长边不超过 1024、不超过 300KB。不透明的 PNG 压成 JPEG（先在 1024 上降质量，还放不下再缩边长）；有透明像素的 PNG 预览仍是 PNG（只能缩边长）。原图本身已经在这两个数以内的原样当预览。Nano Banana、Grok 回的 JPEG 脚本解不开：不超过 300KB 的原样当预览，超过的不带预览、只给路径（约占画图请求的 1.5%）。预览做不出来不算失败。
- **结果文字固定**：「已用 〈型号〉 画好，〈宽〉x〈高〉。文件：〈完整路径〉。回复客户时请原样给出这个路径，不要自己拼路径；客户说看不到图时，告诉他文件在哪，不要重新生成。」换了型号、Grok 不能指定尺寸这两句接在后面。工具说明里的「结果直接显示在对话里」改成了「图片会保存成文件，结果里给出文件路径和一张预览图」：以前 AI 以为客户已经看到图，回复里只列名字或贴一个自己猜的路径，客户说没看到就重画、重复扣费。
- `SKILL.md` 给 Codex 一段照抄的调用代码（在 Codex 里 AI 是写 JS 调 `tools.mcp__xingmang_image__generate_image` 的，第二行把预览图和文字交给对话），「完成后」写明最终回复里逐张给出文件路径、不引用 `.codex/visualizations` 这类猜的路径、客户说没看到图时只给路径不重画。

## 用哪个模型

默认只用 OpenAI 的 gpt-image 系列。登录同步时（`syncXingmangAiSkill`）主进程拿技能的两把 Key 各查一次 `GET /v1/models`，合起来按 `XINGMANG_AI_IMAGE_MODEL_PREFERENCE`（`gpt-image-2.6-flare` → `gpt-image-2.5-flare` → `gpt-image-2`）再 `XINGMANG_AI_IMAGE_MODEL_FALLBACKS`（`gpt-image-2.6-sunburst` → `gpt-image-2.5-sunburst`）的顺序，把账号列表里有的排成一串：第一个写进 `config.json` 的 `model`，后面的写进 `fallbackModels`（可以是空数组）。两把都没查到、或查到了但一个都没有，就两样都不写，画图照旧用 `gpt-image-2`，日志记一句。sunburst 慢、偏精修，flare 和 `gpt-image-2` 在时不当默认。`gpt-image-1` 官方已经下了，`gpt-image-1.5` 站上调不通，都不挑，点名也在本地拒掉。AI 对话的图片默认（`chat/state.ts` 的 `DEFAULT_IMAGE_MODELS`）和图片分组次序（`ai-chat-protocol.ts` 的 `IMAGE_GROUP_MODEL_ORDER`）跟这串同一个顺序，测试钉住。

画图工具把 `model` 当默认值（`tools/list` 的 schema 默认值跟着它走）。AI 没点名、或点的就是这个默认值时，**只有这个型号现在用不了**才按 `fallbackModels` 依次换下一个再试，只换账号列表里有的；老版本写的 `config.json` 没有 `fallbackModels`，照旧只换回 `gpt-image-2`。AI 点名要别的型号就只用那个。换了型号会在结果里说「〈原型号〉 目前无法使用，已改用 〈新型号〉。」（脚本打在 stderr）。

什么算「型号现在用不了」（两个脚本的 `isModelUnavailable`，测试钉住一致；0.2.25，D2）：HTTP 404，错误码 `model_not_found`（new-api 的「当前分组 … 下对于模型 … 无可用渠道」就带这个码，状态 503）或 `model_price_error`（站上新开的型号还没定价），以及原话里有「无可用渠道」「no available channel」「No available compatible accounts」「倍率或价格未配置」。以前是中转只要回了错误就换，内容审核不通过、没给参考图、尺寸超限也把备选型号挨个试一遍（一次「未找到目标图片」试了 5 个型号，一张 25MB 的参考图完整上传两遍）。

换 Key 只在 401、429、503 和余额不足以外的 403。网关错误（502 这类）、连不上、超时既不换 Key 也不换型号，只发这一个请求。

余额不足（两个脚本的 `isInsufficientBalance`，认法跟主程序 `relay-quota-failure.ts` 同一套；0.2.25，D1）：认出来就只发这一个请求，回「当前账号余额不足，无法生成这张图片（需要 $0.20，剩余 $0.14）。请在管理工具中充值后重试。」。两把 Key 是同一个账户，换 Key、换型号一样没钱；以前一次调用最多发 10 个请求，有用户 1 分钟发了 90 个。金额从服务端原话里取、保留两位，只认带美元符号的，取不到就不写金额。Key 自己设的上限用完（`pre_consume_token_quota_failed`）不算余额不足，照旧换另一把 Key。

Nano Banana（`nano-banana-2` / `gemini-3.1-flash-image`、`nano-banana-pro`）和 Grok（`grok-imagine-image` 系列）只在点名时用，只用图片模型分组那把 Key（GPT 分组没有这些模型，没有那把 Key 就直接提示登录或开通，不发请求）。Nano Banana 走 Gemini 原生接口 `POST /v1beta/models/{model}:generateContent`（站上 Gemini 渠道走 Images API 会回 500「only imagen models are supported」），鉴权头用 `x-goog-api-key`（2026-11-11 实测它和 `Bearer` 站上都认），尺寸用 `imageConfig.imageSize`（1K/2K/4K）加 `aspectRatio`，图从 `candidates[].content.parts[].inlineData` 取，改图时参考图放进 `parts`。Grok 走 `/v1/images/generations`（改图 `/v1/images/edits`），要 `response_format: b64_json`；实测只出 1280x720，传 `aspect_ratio` 也不变，所以不传尺寸。两家回的都是 JPEG。

认型号三处用同一套规则（主进程 `OPENAI_IMAGE_MODEL_PATTERN` / `GEMINI_IMAGE_MODEL_PATTERN` / `GROK_IMAGE_MODEL_PATTERN`、`mcp-server.mjs`、技能脚本 `generate.mjs`，测试钉住一致）；`config.json` 的默认模型只收 `gpt-image-*`。以前画图工具只认写死的 5 个，站上新出的型号会被悄悄换回 `gpt-image-2`（#1059）。工具 schema 的 `model` 不列枚举，只给默认值和一句说明；点名认不出的型号时，报错里列出能用的型号。

尺寸两边一样：`size` 可以写宽x高，也可以写 1K/2K/4K 配 `aspect`（16:9、9:16、1:1、4:3、3:4、3:2、2:3）。`size` 已经写了宽高、又给了 `aspect` 时，比例对得上（差 2% 以内，宽高凑成 16 的倍数会差一点）就照 `size` 画，对不上才报错并写出两边各是什么比例；以前一律报错，AI 常常两个都传。gpt-image 系列换成比例不变、都是 16 倍数、总像素在 655,360 到 8,294,400 之间的宽高，长边 1024 / 2048 / 3840（2K 16:9 = 2048x1152，4K 16:9 = 3840x2160，4K 1:1 顶格是 2880x2880，1K 16:9 = 1280x720）。默认画质 `high`：站上各画质同价，2026-11-11 实测 `gpt-image-2.6-flare` 三档各 3 张，low 平均 25.9 秒、medium 27.5 秒、high 24.4 秒。

## 安全边界

- Key 不写进任何工具的配置，只通过环境变量 `XINGMANG_IMAGE_CONFIG_PATH` 告诉脚本 `config.json` 在哪；脚本先用 Codex Key，401/403/429/503 时换生图分组 Key。上游报错里的 `sk-…`、`Bearer …` 打码。中转没说原因时（只有状态码，或者 new-api 拿 `openai_error` 这类错误类别名充当原因），两个脚本都换成「〈模型〉这次没能出图/改图，图片服务没说原因」加一句该怎么办；画图工具把原话写进 stderr（宿主记进日志，不进对话），命令行脚本的 stderr 就是 AI 读的，原话不打（0.2.25 总单第 51 项，Mac 验收 R9）。
- 只连 `https://xm.solov.cc` / `https://api.solov.cc` / `https://xm-direct.solov.cc` 的 `/v1/images/generations`、`/v1/images/edits` 与 Nano Banana 的 `/v1beta/models/{model}:generateContent`，拒绝重定向，300 秒超时（管到读完响应体），响应 32MB 上限，模型只收上面三套规则认得出的。
- 改图读取的原图：必须是绝对路径、单个普通文件（拒符号链接，lstat 与 fstat 同一文件）、不超过 20MB、按文件头判定为 PNG/JPEG/WebP，最多 4 张。被提示词注入要求「改一下 ~/.ssh/id_rsa」时，内容校验会拒绝上传。
- 写文件只有一种：把画好的原图存成一个新文件，位置由脚本自己定（见「画好以后交回什么」），不收调用方给的路径，不覆盖、不删除任何已有文件。
- 退出账号只清 Key，工具条目保留；调用时会提示重新登录，不会用旧凭据。

## 技能脚本这条路（`generate.mjs`）

没有画图工具时 AI 在终端里跑它，受命令沙箱管。0.2.25（D3）起：

- 请求一个字节都没发出去就失败（沙箱禁止联网、网络不通）时，打一句固定的话并以**退出码 3** 退出：「无法连接图片服务：这条命令可能被沙箱禁止联网，也可能是当前网络不通。请允许这条命令联网后重新运行一次；仍然失败请检查网络。」带着 Codex 给断网命令设的 `CODEX_SANDBOX_NETWORK_DISABLED` 时把原因说死。以前只打 `fetch failed`，AI 看不出原因，换着办法试上几分钟。
- 请求已经发出、没等到回复的不算这一种（服务端可能已经出图并扣费）：退出码仍是 1，提示先去用量记录里确认。两种靠 Node 自带 fetch 的 `undici:client:sendHeaders` 诊断频道分开；哪个 Node 版本没有这个频道，就一律按连不上处理。
- `SKILL.md` 的「失败时」：余额不足不重试不换型号；退出码 3 申请联网后只重跑一次；没有画图工具也跑不了脚本时直接告诉客户去管理工具里处理；不读 `config.json`、不自己写代码调接口、不装包、不换别的画图服务、不建定时任务。`references.md` 开头写明它只是接口说明。「没有 Node 时再手写请求」那句删了，它和「禁止读取 `config.json`」自相矛盾，AI 正是照它去读 Key、自己写脚本的。
- 我们不放开 Codex 沙箱的全局联网（`sandbox_mode`、`network_access` 都不动）。

## 待真机确认

- Codex 桌面端第一次调用是否还会弹「允许吗」（源码 `mcp_tool_call.rs` 里 `approve` 直接跳过确认，但桌面端的自动审核有没有另一道没实测）。
- 没装 Node 的电脑：现在会改用 Codex 桌面端自带的那份。Windows 上那份 `node.exe` 到底在 `bin\` 里还是上一层、能不能正常跑脚本、Codex 升级后路径变不变，都没在真机上看过。两处都没有时登记照旧跳过并在日志里写「这台电脑上没有找到 Node.js」。
- Codex 桌面端把图片显示成图的体积上限（现在按约 1MB 估，预览压到 300KB 以内）；有条件的话找一台还在 0.169 或更早版本的电脑对比老版本怎么显示大图。
- Codex 桌面端的最终回复里，用什么写法能直接显示或点开本地图片（现在只要求写出完整路径）。
- Codex 桌面端、Codex 命令行、Claude Code 各自启动画图工具时的当前目录是什么，图实际落在 `outputs/` 还是图片文件夹。
- Grok 调 MCP 工具时是否要确认。
