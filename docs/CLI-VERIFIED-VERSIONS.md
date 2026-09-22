# CLI 已验证版本名单（N1）

名单本身在 `electron/cli-verified-versions.ts`，这份文档说明它为什么存在、怎么维护。

## 为什么需要它

本产品把四个 CLI 的 base URL 全部指向自家中转，而这些 CLI 每周都在发版，**针对第三方 base URL 的回归是反复出现的，不是偶发**。
Claude Code 官方 changelog 里就有两条直接命中本产品形态的：

| 版本 | changelog 原文要点 |
|---|---|
| 2.1.268 | 修复「第三方 Anthropic 兼容端点（`ANTHROPIC_BASE_URL`）上每次请求都返回 400」，**自 2.1.265 起** |
| 2.1.277 | 修复「`ANTHROPIC_BASE_URL` 指向代理或网关时每次请求因 `400 … Input tag 'advisor_20260301'` 失败」，**2.1.275 引入的回归** |

也就是说确实存在这样的版本窗口：用户把 CLI 更到最新，整条链路全线不可用。
在客户那里它的表现是「星芒坏了，我要退款」，而客服既看不出对方在用哪个 CLI 版本，也没有手段让他退回去。

**2026-09-17 这件事在 Codex 上又发生了一次，而那时名单还管不到 Codex。**
`rust-v0.155.0` 让新会话默认索要 detailed 推理摘要，官方 PR 的原话是
*「New local TUI sessions in 0.155 request detailed reasoning summaries by default, which causes request rejection on providers that do not support reasoning summaries.」*
次日的 `rust-v0.155.1` 把默认改了回去（*「Explicit reasoning-summary settings remain respected」*）。
Codex 那时 `recommended` 是 `null`，也就是那两天点过「更新」的客户装到的正是 0.155.0，而首页什么也不会提示。
依据：<https://github.com/openai/codex/releases/tag/rust-v0.155.1>、<https://github.com/openai/codex/pull/46467>。

## 名单管什么

每个 provider 一条 `recommended`（推荐安装的确切版本）和一组 `blocked`（已知不兼容的版本区间 + 一句中文原因）。

- **安装与更新默认装 `recommended`**，而不是 npm latest。`recommended` 为 `null` 的 provider 继续装 latest，行为与从前完全一致。
- **已装版本落在 `blocked` 区间时**，首页那一行显示「已知问题，建议更新到 x.y.z」并给出「更新到推荐版本」按钮。
  推荐版本比已装版本旧时，这两处都改说「回到」——方向由主进程比过版本号后随 `CliVersionAdvice.recommendedIsNewer` 给出，渲染层不自己比。
  Codex 0.155.0 就是往前走一个补丁版的例子：一律写「回到」会把用户指反方向，而按钮装的是更新的那一版。
- 用户可以在「设置 → 更新」里打开**「命令行工具总是装最新版」**跟随官方最新版；默认关闭。打开后不再显示「推荐 x.y.z」，但**已知问题的提示与切到推荐版本的入口仍然保留**——那是安全网，不是建议。
- 名单把安装钉在已装的那个版本上时，工具行不会再显示「有更新」：点了也只是把同一个版本重装一遍。`latestVersion` 仍照实记录 npm 上的最新版，不瞒着上游进度。

`blocked` 区间是左闭右开的 `[introduced, fixed)`；`fixed: null` 表示上游还没修，区间一直开着。

## 名单之外的第二道保险：关掉 Claude Code 的 Artifact 工具

名单是「事后」的：上游出了回归，我们才知道该钉住哪一版。有一类回归可以从根上去掉——
**请求里那些本产品用不上的工具，它们的输入 schema 也要过中转的校验。**
2.1.265~2.1.268 那次「第三方 Anthropic 兼容端点每轮请求 400」就是这样：上游 2.1.268 的
修复原文说，载体是 **Artifact 工具输入 schema 里的一段正则**被那些端点拒绝。这个工具的作用
是把结果发布成 claude.ai 上的链接，走中转 API Key 的客户点开是空的——对他们毫无用处，却能
让每一轮请求都失败。

所以 `electron/config-files.ts` 的 claude 分支在写给 Claude Code 的 `settings.json` 里加了
`permissions.deny: ['Artifact']`：**只在星芒账号来源下写**，切回官方 Claude 账号时删掉
（Artifact 对 claude.ai 账号用户是有用的），用户自己写的其他 `deny` 项原样保留。

**验证依据**（沙箱、`@anthropic-ai/claude-code@2.1.277`、空 HOME、本地 HTTP 假接口原样落盘请求体）：

- `permissions.deny` 写一个裸工具名时，**不是只拦执行，而是把该工具的定义整条从请求体的
  `tools` 数组里摘掉**——这正是防住 schema 类 400 所需要的那一种。基线 25 个工具；
  改成 `deny: ['Artifact', 'WebFetch', 'NotebookEdit']` 后剩 23 个，`WebFetch` 与
  `NotebookEdit` 都不在 `tools` 里了。
- 在 `permissions.defaultMode: 'bypassPermissions'`（就是本产品模板写的那个）下同样生效；
  设置放 `~/.claude/settings.json` 这个位置有效。
- 工具在请求里的真实名字就是 `Artifact`。
- 同一次抓包里，**2.1.277 指向第三方端点时本来就没有发 `Artifact`**（上游已按凭据来源把它
  挡在外面）。也就是说这条 deny 今天是零作用的保险，它挡的是「上游哪天又把它发出来」，
  以及顺带让 Claude Code 不再提议发布用户点不开的链接。

复核办法与上面抓包一致：空 HOME 装名单里的推荐版本，起一个把请求体落盘的本地 HTTP 接口，
把 `ANTHROPIC_BASE_URL` 指过去、`ANTHROPIC_AUTH_TOKEN` 随便填，跑 `claude -p "hi"`，
看请求体的 `tools[].name`。**不要对生产中转发这类探测请求。**

## CLI 自己的更新机制：不关掉，名单等于白钉

名单只决定**本软件装哪一版**。四个 CLI 装完之后各自还带着一套更新机制，全都绕开名单：

| CLI | 开关 | 写在哪 | 默认 |
|---|---|---|---|
| Claude Code | `DISABLE_AUTOUPDATER=1` | `~/.claude/settings.json` 的 `env` 段 | 后台自更新开着 |
| Gemini CLI | `general.enableAutoUpdate` / `general.enableAutoUpdateNotification` | `~/.gemini/settings.json` | 两个都是 `true` |
| Codex | `check_for_update_on_startup = false` | `~/.codex/config.toml` 顶层 | `true`（只催更，不自更新） |
| Grok | `[cli] auto_update = false` | `~/.grok/config.toml` | `true`（等价环境变量 `GROK_DISABLE_AUTOUPDATER`） |

不关的后果很具体：客户今天装到名单推荐的版本，明天 Gemini CLI 启动时自己 `npm install -g
@google/gemini-cli@latest`，就跑在了我们没验过的版本上；Claude Code 在托管目录可写时同样会
自己升上去，不可写时（Windows 的 `%ProgramData%` 就是这种）则每次启动弹一条英文提示，客户
照着做等于在自己的 npm 目录里装第二份；Codex 与 Grok 不自更新，但启动时给出 `npm install -g
…@latest`，照做的结果一样。

所以 `electron/config-files.ts` 写配置时一并把这四个开关关掉，`reset` 与 `merge` 两条路都写，
`merge` 只增改这几个键、用户已有的其他设置原样保留。**切回官方账号时不收回**：CLI 仍然是本
软件装的、也由本软件更新，账号来源换了这一点没变。更新提醒仍走首页的新版本角标与一键更新
（A5），那条路径走 npm 官方源并对 SHA-512，CLI 自己的 `npm install -g` 没有这一层。

**验证依据**（沙箱，2026-09-22，空 HOME，装的都是名单里的推荐版本）：

- **Claude Code 2.1.277 — 跑起来看到了**。`~/.claude/settings.json` 写
  `{"env":{"DISABLE_AUTOUPDATER":"1"}}`，`env -i` 清空真实环境变量后跑 `claude doctor`：
  `Auto-updates: disabled (set by env: DISABLE_AUTOUPDATER)`。同一台机器上不写这个键时是
  `Auto-updates: enabled` 外加一行 `- Can't auto-update: npm global folder isn't writable`。
  二进制里那段判定先看 `DISABLE_UPDATES`、再看 `DISABLE_AUTOUPDATER`，与安装方式无关，所以
  对官方原生安装器装的那一份同样生效（这一条是读二进制得出的，没有真机演过）。
  刻意**不用** `DISABLE_UPDATES`：那个连手动 `claude update` 也一起禁掉。
- **Codex 0.155.1 — 跑起来看到了**。`~/.codex/config.toml` 写
  `check_for_update_on_startup = false` 后跑 `codex doctor`，Updates 一节的
  `startup update check` 从 `true` 变成 `false`。这个键是 `ConfigToml` 的顶层字段。
- **Gemini CLI 0.60.0 — 只到「配置被接受」这一步**。键名与默认值出自它自己打包进来的
  `docs/cli/settings.md`（`general.enableAutoUpdate`，默认 `true`）与 bundle 里的 settings
  schema（`enableAutoUpdateNotification`，默认 `true`）；bundle 里的更新处理函数先判
  `enableAutoUpdateNotification`（假则直接 return，一条提示都不出），再判 `enableAutoUpdate`
  （假则只发提示、不去 spawn 更新命令）。写上这两个键跑 `gemini -p` 能正常启动、无配置告警。
  **但沙箱里没能让它真的弹出那条催更提示**（版本检查本身没出结果），所以「关掉之后提示消失」
  这一句是读代码得出的，没有演过。
- **Grok 1.0.40 — 只到「配置被接受」这一步**。键名出自二进制里内嵌的配置表：
  `| cli.auto_update | boolean | pin | user | Check for CLI updates on launch. Also
  GROK_DISABLE_AUTOUPDATER to suppress. |`。写上 `[cli] auto_update = false` 后
  `grok inspect` 正常读出配置、不报解析错误，但它不打印更新相关的状态，所以同样没有前后对比。

复核办法：`npm install --no-save --prefix <临时目录> <包名>@<名单版本>`，用一次性 HOME 起
`claude doctor` / `codex doctor` 看对应那一行。**不要对生产中转发这类探测请求**，上面几条都
不需要联网到中转。

## 本软件替用户改了哪些 CLI 默认值

除了 Key 与 base URL 这些中转必需项，`electron/config-files.ts` 还替用户动了几个上游默认值。
集中列在这里，便于客服回答「我是不是被改了什么」：

| 改的是什么 | 写在哪 | 上游默认 | 我们写成 | 为什么 |
|---|---|---|---|---|
| 四家的自更新 | 见上一节 | 都开着 | 关掉 | 不关名单等于白钉 |
| Claude 的 Artifact 工具 | `~/.claude/settings.json` 的 `permissions.deny` | 不禁 | 禁掉 | 中转 Key 用不了它，且它的 schema 曾整轮 400 |
| Claude 的读网页预检 | `skipWebFetchPreflight` | 每抓一个域名先问 `api.anthropic.com` | 跳过（只在星芒来源下写，切回官方删掉） | 国内连不上那台主机，WebFetch 要么立即失败、要么等 30 秒后失败 |
| Claude 的命令确认 | `permissions.defaultMode` | `default`（逐条问） | `bypassPermissions` | 本产品的卖点就是不用自己配、也不用自己按确认 |
| Claude 的回复语言 | `language` | 未设（跟着对话语言走） | `简体中文` | 只靠 AGENTS.md 撑不住：克隆来的项目大多已有说明文件，模板不会生成 |
| Claude 的记录保留期 | `cleanupPeriodDays` | 30 天 | 365 天 | 记录页、「接着聊」、导出都建立在文件还在的前提上 |
| Claude 的状态行 | `statusLine` | 未设（终端里没有状态行） | 指向随包脚本的一条命令 | 用户按 token 付费，却看不到在用哪个模型、上下文吃到几成 |
| Gemini 后台功能用的型号 | `modelConfigs.customOverrides` | 联网搜索、读网页、压缩、子代理、会话摘要、Auto 各自写死 Google 官方型号名 | 这批官方型号名统一改写成当前配的中转型号（只在星芒来源下写，切回官方删掉） | 中转没有这些型号时，这些功能默默重试几分钟后失败 |
| Grok 画图与视频工具的地址 | `~/.grok/config.toml` 的 `[endpoints] xai_api_base_url` | `https://api.x.ai/v1` | 与对话同一个中转地址 | 这几个工具带的是同一把 `api_key`，不改就把中转 Key 发给 xAI 官方，国内还要卡 120 秒 |
| Gemini 的记录保留期 | `general.sessionRetention.maxAge` | `"30d"` | `"365d"` | 同上 |
| Gemini 的 IDE 模式 | `ide.enabled` | 关 | 开 | 装在 IDE 里的客户少一步 |
| 目录信任 | 见 `docs/WORKSPACE-TRUST.md` | 每次问 | 本软件打开的目录替用户信任 | 同上 |
| Gemini 的说明文件名 | `context.fileName` | `GEMINI.md` | 加上 `AGENTS.md` | 四家共用一份说明文件 |

状态行与后三项之外，**语言与两个保留期是用户偏好而不是中转配置**：用户自己设过就一字不动（`merge`
路径只在键缺省时补），切回官方账号时也不收回（`reset` 重建官方模板时一并写回，否则换回官方
账号的用户会悄悄回到 30 天自动删）。

检查页的「Claude 命令确认方式」那一项因此要分来源：确认是本软件替当前账号写的
（`tool-config-ownership` 读出 `account`）就是正常状态，判不准时才提醒——否则每个配置正常的
用户都会被我们自己造成的配置警告一次。

**验证依据**（沙箱，2026-09-22）：

- **Claude Code 2.1.278 的 `statusLine` 入参 —— 跑起来抓到了**。给 `~/.claude/settings.json`
  写一条把 stdin 落盘的 `statusLine` 命令，在伪终端里跑一次 `claude`，抓到的就是下面这些键
  （随包脚本 `bundled-catalog/cli-status-line/xingmang-statusline.cjs` 只认这三处）：

  ```jsonc
  {
    "model": { "id": "claude-sonnet-5", "display_name": "Sonnet 5" },
    "workspace": { "current_dir": "…", "project_dir": "…", "added_dirs": [] },
    "context_window": {
      "total_input_tokens": 0, "total_output_tokens": 0,
      "context_window_size": 1000000,
      "current_usage": null, "used_percentage": null, "remaining_percentage": null
    },
    "cost": { "total_cost_usd": 0, … }, "exceeds_200k_tokens": false, "version": "2.1.278"
  }
  ```

  要紧的两点：**一次请求都没发过时 `used_percentage` 是 `null` 而不是 0**（脚本这时按
  `total_input_tokens / context_window_size` 自己算，`Number(null)` 是 0，照着写会显示成假的
  0%）；`context_window_size` 跟着模型走，1M 上下文的模型回的就是 1000000。二进制里这条命令
  的刷新间隔是 300 毫秒，所以脚本必须只读 stdin、不出网、不读配置文件。
  `cost.total_cost_usd` 是 Claude Code 按官方价自己算的，**与中转计费对不上，刻意不显示**。
  同一次运行里还确认了：**命令是交给 shell 执行的**，两段路径各自加引号后，装在带空格的
  目录里照样跑得起来（Linux 实测）。Windows 那侧只有间接证据——包里给插件命令写的是
  「平台 shell（macOS/Linux 用 `sh`，Windows 用 `cmd.exe`）」，而 CLI 里跑用户命令的地方
  都是 `spawn(命令, [], { shell: true })`，Node 在 Windows 上会补 `cmd.exe /d /s /c` 与外层
  引号，所以 `"<node>" "<脚本>"` 这种写法是稳的。**真机没演过，出包后要看一眼。**

- **Claude Code 2.1.277 的读网页预检 —— 跑起来看到了**。本机假接口当中转、出网代理把官方主机
  全部拒掉或静默丢包，让模型调一次 WebFetch 抓本机的 https 页面：拒掉时工具立刻报
  `Unable to verify if domain … is safe to fetch. This may be due to network restrictions or
  enterprise security policies blocking claude.ai.`；丢包时 debug 日志是
  `WebFetch tool error (30006ms) … EDEADLINE_PREFLIGHT`，干等 30 秒。settings.json 顶层写
  `"skipWebFetchPreflight": true` 后同样条件 1.2 秒抓到，且不再请求 `/api/web/domain_info`。
  另外确认了 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` **不会**跳过这一步。2.1.278 表现相同。
- **Claude Code 2.1.277 — 跑起来看到了**。`~/.claude/settings.json` 写
  `{"language":"简体中文"}`，把 `ANTHROPIC_BASE_URL` 指到本机假接口（原样落盘请求体、一律回
  500）后跑 `claude -p "hi"`，请求体的系统提示里出现
  `# Language\nAlways respond in 简体中文. Use 简体中文 for all explanations, comments, and
  communications with the user.`——值是被原样插进那段英文提示的，所以写中文名字就行。
  二进制里这个键的 schema 是 `string().optional()`，描述原文
  `Preferred language for Claude responses and voice dictation (e.g., "japanese", "spanish")`，
  没有格式限制。
- **Claude Code 2.1.277 的 `cleanupPeriodDays` — 读二进制得出**。schema 是
  `int().positive().optional()`，描述原文
  `Number of days to retain chat transcripts before automatic cleanup (default: 30). Minimum 1.
  Use a large value for long retention`，校验失败时的提示原文是
  `cleanupPeriodDays must be at least 1. To keep transcripts for a long time, set a large number
  (e.g. 3650 for ~10 years).`——**所以「不删」只能靠写一个大数，写 0 会被拒**。
- **Gemini CLI 0.60.0 的后台型号 —— 跑起来看到了**。本机假接口只放行中转型号
  `gemini-3.8-flash-high`、其余型号一律回「无可用渠道」。不做改写时：联网搜索与读网页发的是
  `gemini-3-flash-preview`，默默重试 2.5 分钟以上；`/compress` 发
  `gemini-3.1-pro-preview-customtools`，转圈一分多钟；有过上一次会话时，启动就用
  `gemini-3.1-flash-lite` 写摘要；`-m auto` 先用 flash-lite 分类再用 `gemini-3.1-pro-preview`，
  77 秒后报错。用 `config-files.ts` 生成的 settings.json 复跑联网搜索，`googleSearch` 那次请求
  打到 `gemini-3.8-flash-high`，全程 2.2 秒。型号表出自 bundle 的 `DEFAULT_MODEL_CONFIGS`，抬
  Gemini 推荐版本时要重新核。
- **Grok 1.0.40 的画图工具 —— 跑起来看到了**。二进制里的配置表原文
  `| endpoints.xai_api_base_url | string | pin | user | Public xAI API base. Also GROK_XAI_API_BASE_URL. |`。
  本机假接口当中转、出网代理记录去官方主机的连接，让模型调一次 `image_gen`：不改时请求带着
  `Authorization: Bearer <中转 Key>`、型号 `grok-imagine-image-quality` 去连 `api.x.ai`，
  官方主机被丢包时 `-p` 卡满 120 秒；写上 `[endpoints] xai_api_base_url = "<中转>/v1"` 后
  请求变成打到中转的 `POST /v1/images/generations`，整次 0.5 秒，没有任何去 `api.x.ai` 的连接。
- **Gemini CLI 0.60.0 — 读 bundle 得出**。settings schema 里 `general.sessionRetention` 的
  `enabled` 默认 `true`、`maxAge` 默认 `"30d"`、`minRetention` 默认 `"1d"`；`maxAge` 的解析是
  `/^(\d+)([dhwm])$/`，`"365d"` 合法。要紧的是 `getDefaultsFromSchema` **会递归补齐嵌套默认
  值**，所以用户的 `settings.json` 里没有这一段时清理照样按 30 天跑，不是「没配就不清」。
  被清的目录是 `getProjectTempDir()/chats`，正是记录页读的那一处。

## 站点维度

`VerifiedCliRelease.verifiedSites` 与 `BlockedCliVersionRange.sites` 记录条目对应哪些中转站点（`relay-sites.ts` 的 `RelaySite.id`）。
`sites` 缺省 = 所有站点，这是常态：上游回归打的是「第三方 base URL」这一整类，与站点无关。

**双站点是有意做成用户无感的，所以站点信息只存在于数据与文档里，永远不出现在界面文案上。** 用户只看到「推荐版本」。

## 怎么更新名单

1. 读上游 changelog（Claude Code 是 `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`），找与 `ANTHROPIC_BASE_URL` / 第三方端点 / 网关相关的修复与回归。
2. 有新的回归窗口 → 往 `blocked` 里加一条，`introduced` 写 changelog 明说的引入版本，`fixed` 写修复版本，`reason` 用一句用户读得懂的中文。
3. 实测新版本可用 → 更新 `recommended`：`version` 填确切版本号，`verifiedAt` 填验证日期，`verifiedSites` 填实测过的站点 id（没实测就留空数组并在 `note` 里说明依据）。
4. `npm test` 会验证：名单覆盖全部 provider、版本号是精确 semver、**推荐版本不落在自己的 `blocked` 区间里**、每条推荐都有验证日期和中文备注。

### 名单今天覆盖到哪

| 工具 | `recommended` | `blocked` | 依据 |
|---|---|---|---|
| Claude Code | `2.1.277`（2026-09-18） | `[2.1.265, 2.1.268)`、`[2.1.275, 2.1.277)` | 上游 changelog 两条网关回归 |
| Codex CLI | `0.155.1`（2026-09-21） | `[0.155.0, 0.155.1)` | 上游 release note 与 PR #46467（见上一节） |
| Gemini CLI | `0.60.0`（2026-09-21） | 无 | 当前 npm `latest`；0.57~0.60 四个正式版全是安全加固，未发现与第三方 base URL 相关的回归 |
| Grok CLI | 无 | 无 | 还没有遇到过需要挡的版本，行为与从前一致（装 npm `latest`） |

三条 `recommended` 的 `verifiedSites` 目前都是空数组：中转实测所需的仓库 secret 还没配（见下文），所以这三个版本都还**没有**在任何站点上跑过真实请求。跑通之后把站点 id 填进去。

加第四个工具只需要填上它的 `recommended`，其余代码不用动；要让中转实测也覆盖它，还得在 `scripts/probe-cli-relay.cjs` 的 `probeRunners` 里加一条。

## 谁来跑：每周巡检

名单越旧，默认装的版本离上游越远；而没人盯着的话，它只会在客户报障那天才被想起来。所以有一条每周的巡检例程（Routine）替人盯着：

- **名字**：`Claude Code 新版每周巡检`
- **频率**：每周一 01:00 UTC（北京时间周一 09:00）
- **它做什么**：取 npm 上 `@anthropic-ai/claude-code` 的 `latest`，和名单里的推荐版本比。一样就只回一句「本周无新版」；不一样就把这两个版本之间的上游 changelog 逐条读一遍，摘出与网关 / 代理 / 第三方 base URL / 鉴权 / 400 相关的行。没有回归就开一个**草稿 PR** 抬推荐版本（含文档与 `changes/unreleased/` 分片）；有回归就改为把新版加进 `blocked` 并写清原因。
- **它不做什么**：不自己合并。抬版本的 PR 一律留给人复核——中转实测没跑过、或者跑红了，都不许合。

**建议把这条巡检扩到 Codex 与 Gemini**（这份 PR 没有动 routine 本身，它归「Claude Code 新版每周巡检」那条线程管）：

- **Codex 最该扩**。它现在几乎每天发 alpha、正式版每周一发，0.155.0 那次回归的窗口只有一天——每周看一次仍会漏，但至少名单不会一直停在几个月前。上游看 `https://github.com/openai/codex/releases`（`rust-v*` tag），关注的关键词是 reasoning summary、wire API、`requires_openai_auth`、third-party provider。
- **Gemini 一并扩，但频次可以低**。它一周一个正式版，0.57~0.60 都是安全加固；要盯的是 `GOOGLE_GEMINI_BASE_URL` 与 `security.auth.selectedType` 这两处——上游已经把带 base URL 的情形单独识别成 `AuthType.GATEWAY`，哪天它把 `gateway` 做成正式的 `selectedType`，本产品写的 `gemini-api-key` 就要跟着改。
- **Grok 暂不扩**：名单里没有它的条目，巡检也没有可比的基准。
- 扩之后那条 routine 的判据不变：只看 npm `latest`（`stable` 这个 dist-tag 不可信，它曾经指向 blocked 区间里的版本），比对上游 changelog，开草稿 PR，不自合。

npm 上的 `stable` 这个 dist-tag **不能用作判断依据**：它曾经指向 `2.1.267`，而那个版本正落在名单里 2.1.265–2.1.268 那条不兼容区间内。只看 `latest`。

## 谁来验：CI 里的中转实测

「这个版本在我们的中转上能用」这句话，过去只有上游 changelog 作背书。但名单挡住的三次回归都是 **CLI 自己发出的请求**被第三方端点拒掉——用 `curl` 手搓一个请求验证不了，出问题的正是 CLI 构造请求的那一段。

所以 quality 工作流里有一个 `cli-relay-probe` 作业（`scripts/probe-cli-relay.cjs`）：

- **什么时候跑**：PR 改到 `electron/cli-verified-versions.ts` 或本文档时。别的 PR 改不动这个答案，不值得对生产中转发真实请求。
- **跑什么**：名单里**每一个**填了 `recommended` 的工具各装一次那个版本，再对 `relay-sites.ts` 里的**每个**中转站点各跑一次最小请求，结论写进 job summary。今天是 Claude Code、Codex、Gemini 三个工具 × 两个站点 = 六次真实请求。
  - Claude Code：`claude -p`，凭据走 `ANTHROPIC_AUTH_TOKEN`。
  - Codex：`codex exec`，配置是一份与 `config-files.ts` 的 `buildCodexRelayConfigTemplate` 同形的 `config.toml`（`wire_api = "responses"`、`model_reasoning_effort = "xhigh"`）。
  - Gemini：`gemini -p --skip-trust --approval-mode plan`，凭据与 base URL 走 `GEMINI_API_KEY` / `GOOGLE_GEMINI_BASE_URL`。
- **为什么连接自检不能代替它**：自检只读模型清单，而三个 CLI 真正打的端点各不相同（Claude 的 `/v1/messages`、Codex 的 `/responses`、Gemini 的 `/v1beta/models/<model>:streamGenerateContent`），请求体更是天差地别。0.155.0 那类回归改的正是请求体。
- **密钥**：仓库 secret `XINGMANG_CLI_PATROL_KEY`，一把额度很小的测试 Key。**三个工具共用这一把**，不另设第二个 secret。
  - 但它必须覆盖三个工具各自的分组（`catalog.ts` 的 `managedCliKeyProfiles`：`Claude-MAX订阅` / `GPT-中转/订阅` / `Gemini-中转/订阅`）。只覆盖其中一个分组时，另外两个工具会被中转答成「当前分组下无可用渠道」。
  - 探测脚本把这种回答单独归成 `group` 一类并在 summary 里写清「换一把覆盖该分组的 Key」，**不会**把它误报成「这个版本不能用」。
  - Claude Code 与 Gemini 从子进程环境变量拿 Key。Codex 对自定义 model provider **不认** `OPENAI_API_KEY` 环境变量（对 0.155.1 实测：设了这个变量，请求里 `auth.header_attached=false`），只读 `$CODEX_HOME/auth.json`，所以它那一份是以 0600 写进一次性临时 HOME 的，跑完即删。三种路径都不经 argv——argv 在共享主机上是全员可读的。
- **没有配密钥时**：作业照常通过，但 summary 里明确写「未在中转实测」，并列出这次本该探测的是哪几个工具的哪几个版本。一句诚实的「没验证」比一个看着绿的空作业有用。
- **结论怎么读**：只有「端点拒绝了 CLI 发出的请求（400 类）」才说明这个版本不能推给客户。分组不对、401/403、额度不足、5xx 是**探测本身坏了**，作业同样变红，但那是去换密钥或等中转恢复，不是去改名单。

跑通之后，把跑通的站点 id 写进对应那条 `recommended` 的 `verifiedSites`。

## 不要做的事

- 不要把 `recommended` 写成 `latest`、`^2.1.0` 这类范围或 dist-tag。IPC 侧只接受精确 semver（`ipc.ts` 的 `parseCliInstallVersion`），范围表达式会让 npm 自己去决定装什么，等于绕过名单。
- 不要为了「让用户拿到新功能」把过期的 `recommended` 留着不动——名单越旧，默认装的版本离上游越远。上游发了新版就跑一次验证。
