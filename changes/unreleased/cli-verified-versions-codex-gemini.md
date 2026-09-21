## 用户

- Codex CLI 和 Gemini CLI 现在也有推荐版本了：装和更新默认装我们验过的那一版，
  不再是当天 npm 上的最新版（想跟最新版的，「设置 - 更新」里那个开关照旧管用）。
- 装到 Codex 0.155.0 的话，首页那一行会写「已知问题，建议更新到 0.155.1」，
  旁边有一键换过去的按钮。那个版本每次都向中转索要推理摘要，会被直接拒掉，
  OpenAI 第二天就出了修复版。
- 推荐版本比手上这版新的时候，提示和按钮改说「更新到」，不再一律写「回到」——
  以前遇到这种情况会把方向说反。

## 开发

- `electron/cli-verified-versions.ts` 扩到三个工具：`codex.recommended = 0.155.1` 并把
  `[0.155.0, 0.155.1)` 写进 `blocked`（上游 `rust-v0.155.0` 让新会话默认索要 detailed
  推理摘要，不支持的 provider 直接拒绝请求，次日 `rust-v0.155.1` 热修）；
  `gemini.recommended = 0.60.0`、`blocked` 留空（0.57~0.60 全是安全加固，未发现与
  第三方 base URL 相关的回归）。Grok 仍留空，行为不变。
- `CliVersionAdvice` 新增可选字段 `recommendedIsNewer`，由主进程比过版本号后给出；
  渲染层的 `recommendedVersionVerb` 据此在「更新到」和「回到」之间选词，首页副标题、
  行内按钮与菜单项三处共用，图标也跟着换。缺省保持旧文案。
- `scripts/probe-cli-relay.cjs` 从写死的 `claude` 改成按 `probeRunners` 表跑三个工具：
  Claude 走 `claude -p`、Codex 走 `codex exec`（配置与 `buildCodexRelayConfigTemplate` 同形，
  `wire_api = "responses"`）、Gemini 走 `gemini -p --skip-trust --approval-mode plan`。
  每个工具 × 每个站点一次真实请求，只有 400 类拒绝才判定版本不可用。
- Codex 对自定义 model provider 不认 `OPENAI_API_KEY` 环境变量（对 0.155.1 实测：设了它
  请求里仍是 `auth.header_attached=false`），只读 `$CODEX_HOME/auth.json`，所以探测把它那份
  密钥以 0600 写进一次性临时 HOME、跑完即删；另外两个工具仍只走子进程环境变量，三条路径都不经 argv。
- `classifyProbe` 新增 `group` 一类：三个工具的托管 Key 各绑一个 new-api 分组
  （`catalog.ts` 的 `managedCliKeyProfiles`），一把只覆盖单一分组的巡检 Key 会被中转答成
  「当前分组下无可用渠道」，那是密钥问题不是版本问题，报告里直接说清要换什么样的 Key。
  仍然只用 `XINGMANG_CLI_PATROL_KEY` 这一个 secret，不新增第二个。
- `quality.yml` 的 `cli-relay-probe` 触发条件不变，步骤名与超时跟着三个工具调整（20 → 40 分钟）。
- `docs/CLI-VERIFIED-VERSIONS.md` 加了三家的覆盖表、Codex 这次的依据与链接、每个工具的探测形态，
  以及把每周巡检扩到 Codex / Gemini 的建议（routine 本身不在这个改动里）。
