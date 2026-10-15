## 用户

- Codex 切到官方账号后，以前在星芒账号下聊的对话点开会报「模型提供者未找到」，现在能打开看记录；要接着聊，在星芒里把 Codex 换回原来的账号。

## 开发

- Codex 切到官方账号不再删掉中转那张 `[model_providers.<表名>]`，改成同名留一张「停着的」：没有 `base_url`、不带 `requires_openai_auth`，只有一个没人设的 `env_key = "XINGMANG_ACCOUNT_KEY"` 和一句中文 `env_key_instructions`。Codex 续接旧对话时用的是对话开始时记下的 `model_provider`（app-server `merge_persisted_resume_metadata`，rust-v0.162.1），配置里没这个表名就报 `Model provider \`OpenAI\` not found`、整段对话打不开；表名 `OpenAI` 的是星芒第一次写配置时电脑上已经有 config.toml 的客户（含 8-26 以前的老客户），从零写的是 `XingmangAI`，两种都中。停着的表让对话照常打开，发消息时 Codex 在拼请求之前就因环境变量缺失报错，ChatGPT 登录发不到中转、两边都不扣费。切回当前账号时 `codexRelayProviderFor` 优先接回停着的表名、`applyCodexRelayConfig` 拿掉那两项再补齐地址和登录方式，旧对话接着聊。新加一张表时接在官方配置原文后面，客户的注释和排版不动；同名表是客户自己写的不动；以前快照里留着的星芒中转活表换成停着的。在官方账号上重置时表名从 `xingmang-config-relay.toml` 里找。沙箱用 Codex 0.162.1 app-server 实测：切官方后 `thread/resume` 成功、`turn/start` 报环境变量缺失且中转收不到请求，切回后续接照常发到中转。
