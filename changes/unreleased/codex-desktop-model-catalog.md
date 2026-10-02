## 用户

- 用星芒账号时，Codex 桌面端的模型菜单里找不到 GPT-6.1 Sol 的问题修好了：星芒会把你账号能用的 GPT 型号交给 Codex，桌面端和命令行的菜单都能选到。升级后打开一次星芒就会补上（自己填写密钥的，重新保存一次 Codex 配置）；桌面端当时正开着的话，完全退出再重新打开才看得到。

## 开发

- 根因：用星芒 Key 时 Codex 的菜单、提示词与工具只取二进制自带的型号名单（`codex-rs/models-manager/models.json`）。2026-09-30 那批桌面端（26.930.x）自带 Codex 0.159.0-alpha.12.1，名单里没有 9-29 才上的 `gpt-6.1-sol`；上游同样的报告见 openai/codex #50282。
- 新增 `electron/codex-model-catalog.ts`：随包一份 openai/codex `rust-v0.160.0` 的官方名单（`bundled-catalog/codex-models/`，原样拷贝、按 sha256 钉住，附 Apache-2.0 的 `LICENSE` / `NOTICE`），按 `/v1/models` 挑出当前 Key 能用的型号，原样写成 `CODEX_HOME/xingmang-models.json`，`config.toml` 顶层写相对路径 `model_catalog_json = "xingmang-models.json"`。
  名单文件与 `config.toml` 同一次两阶段提交、文件先落盘，内容没变不重写；不进 `providerConfigPaths`（工具配置来源指纹不变）。
- 名单读不进去时 Codex 命令行起不来、桌面端开不了新对话，所以：账号的型号一个都对不上、或挑出来的全是隐藏型号时不写并收回本软件那一行；本机 Codex 命令行低于 max(0.147.0, 各型号 `minimal_client_version`)（今天是 0.155.0）也收回；读不出命令行版本时原样不动；用户自己设的 `model_catalog_json` 不碰；切回 ChatGPT 与存官方快照时去掉那一行，名单文件不删。
  沙箱里用假中转跑过七个真二进制（0.146.1、0.147.0、0.150.0、0.153.4、0.156.1、桌面端 26.930 自带的 0.159.0-alpha.12.1、0.160.0）：0.147.0 起都读得进、菜单列出 `gpt-6.1-sol`、请求不再退回通用提示词；0.146.1 报 `missing field base_instructions` 起不来；文件丢了或是空名单时命令行退出、桌面端新对话报 -32600。
- 何时写：`saveConfig` 的每次 Codex 保存；打开前的每日核对（`tool-model-check.ts` 由只管 Claude Code 菜单扩到 Codex，`pickerOutdated` / `refreshPicker` 改为带 provider）；开机补设置之后、Codex 命令行装好 / 更新 / 退回 / 卸载之后各 `syncPicker('codex')` 一次（不劝换型号、不占当天核对），老客户不用重存配置、直接开桌面端也能拿到，退回太旧的命令行也会马上收回那一行。后三处只动来源确认是当前账号的配置，与开机同步 Key 同一套规则。无新增 IPC 通道。
- 已知限制：随包名单要随 Codex 推荐版本一起换（`docs/CLI-VERIFIED-VERSIONS.md` 每周巡检一节）；中转开了随包名单里没有的新 GPT 型号，下一版带上新名单之前菜单里看不到；自己填写密钥的配置不会被自动重写，账号型号变了或命令行退回到 0.147.0 以下要重新保存一次；卸载星芒不收回这一行（与 Key 一样留着，Codex 照常能用，只是名单不再更新）。桌面端菜单在 Windows / Mac 真机上还没看过。
