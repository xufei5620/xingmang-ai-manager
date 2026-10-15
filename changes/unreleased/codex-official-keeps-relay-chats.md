## 用户

- Codex 切到官方账号后，以前用星芒账号聊的对话点开会报「模型提供者未找到」，现在能打开，用官方账号接着聊；切回星芒账号也照常接着聊。这次以前已经切到官方账号的，更新后打开星芒会自动补好。

## 开发

- Codex 切到官方账号不再删掉中转那张 `[model_providers.<表名>]`，改成同名写一张走官方登录的表：`name = "OpenAI"`、`wire_api = "responses"`、`requires_openai_auth = true`，不写 `base_url`。Codex 续接旧对话时用的是对话开始时记下的 `model_provider`（app-server `merge_persisted_resume_metadata`，rust-v0.162.1），配置里没这个表名就报 `Model provider \`OpenAI\` not found`、整段对话打不开；表名 `OpenAI` 的是星芒第一次写配置时电脑上已经有 config.toml 的客户，从零写的是 `XingmangAI`，两种都中。不写地址时 Codex 按 auth.json 选官方默认地址（ChatGPT 登录走 chatgpt.com/backend-api/codex，API Key 走 api.openai.com/v1），显示名正好是 `is_openai()` 认的 `OpenAI`，和内置官方线路一样；这张表和 2026-10-15 客户自己在 Codex 桌面端上改好、旧对话接着回了的那张一字不差（写死 api.openai.com 对 ChatGPT 登录报 `Missing scopes: api.responses.write`）。切回当前账号时照旧用 `xingmang-config-relay.toml` 恢复原样；那份没了时 `codexRelayProviderFor` 优先接回这张表的表名，旧对话跟着回中转。新加一张表时接在官方配置原文后面，客户的注释和排版不动；同名表是客户自己写的不动；以前快照里留着的星芒中转活表换掉；在官方账号上重置时表名从 `xingmang-config-relay.toml` 里找。这次以前就切到官方的客户：开机补设置那一轮（`fillToolTemplateDefaults`）对记着官方账号的 Codex 补这一张表（`restoreCodexOfficialAlias`），只加这一张、先备份、Codex 开着就等下次，与补模板缺省项同一套规矩。沙箱用 Codex 0.162.1 app-server 实测：切官方后 `thread/resume` 成功、新一轮请求和内置官方线路一样发去 chatgpt.com、中转收不到；切回后接着发到中转；模拟老版本删表后报 not found，开机补表后又能打开。
