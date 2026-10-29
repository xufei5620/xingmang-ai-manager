## 用户

- 有些电脑（多见于公司统一配过的）把 Codex 设成了「只能用 ChatGPT 账号登录」，以前星芒显示已经配好，一打开 Codex
  它却把密钥删掉、要你登 ChatGPT。现在用当前账号或自己的密钥时，星芒写 Codex 设置时会替你去掉这条限制；
  切回官方账号时原样放回。

## 开发

- `electron/config-files.ts`：`applyCodexRelayConfig` 里新增 `allowCodexApiKeyLogin`，保存当前账号或自己的密钥时拿掉
  `forced_login_method = "chatgpt"`（去空格、不分大小写，跟 `workspace-config-overrides.ts` 的判法一样）；写的是 `"api"`
  的不动，跟密钥接入不冲突。官方快照（`xingmang-config-chatgpt.toml`）照留原值，切回官方账号原样回来，跟
  `cli_auth_credentials_store` 的先例一样（审查 #1489 D04）。
- 实测：Codex 0.164.0 命令行（linux-x64）连本机假接口，`env -i` 加临时 HOME，用户级 config.toml 只写这一行，经
  `saveProviderConfig` merge 后跑 `codex exec`：改前报「ChatGPT login is required, but an API key is currently being used.
  Logging out.」、退出码 1、auth.json 被删；改后正常出字，请求带的是写进去的密钥，auth.json 还在。
- 不进开机补设置（`fillCodexRelayTemplateDefaults`，`relayTemplateRevision` 不动）：这是客户自己写的值，开机补完那句提示
  说的是「自己改过的设置都没动」。首页也不加新的状态和字：以前版本已经写进去、Codex 已经把 auth.json 删掉的客户，读不到 Key
  后来源判成 unknown（`sourceFor`），首页本来就不再显示配好，点它给的原有按钮（改用当前账号）重新保存就会走到这里（看代码，
  没演过）。
- 测试：`config-files.test.ts` 加三条（从官方切过来拿掉、切回官方原样回来、再切过来仍拿掉；当前账号配置里残留的拿掉、
  写 `"api"` 的不动；开机补设置不碰）。
