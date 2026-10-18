## 开发

- 打开前、开机核对刷新型号菜单不再整份合并重写工具配置，只改菜单那几处，文件其余字节原样（#1154 后续，#1165 留下的那条）。
  以前 `system-service.ts` 的 `refreshPicker` 走 `saveConfig` 的 merge：账号的型号一变，Codex 客户自己定的 `review_model`
  被改回主型号，打开的 `check_for_update_on_startup` 被关回去，注释冲掉；Claude Code 放开的 Artifact、DesignSync 被补回 deny，
  另指的 `env.ANTHROPIC_DEFAULT_MODEL` 被改回当前型号，缩进改成两格。现在交给新的 `refreshToolPicker`，由 `config-files.ts` 的
  `planProviderPickerRefresh` / `applyProviderPickerRefresh` 定点改写，闸同 `replaceToolModel`，来源记录、模板版本号都不动。
- 改的只有菜单本身。Codex：型号名单文件按 `resolveCodexModelCatalog` 重写；`config.toml` 里本软件那一行该有却没有就补在第一张表前
  最后一个键后面（读回来必须恰好只多这一个键，不然退到第一张表前、文件开头再试），不该有就按行收回，客户自己指向别处的不动；
  只重写名单时配置文件不碰，也不多一份备份。Claude Code：`modelPicker` 没写过或是本软件写的才换，用 jsonc-parser 按原来的缩进改，
  改完整份再读一遍比对，同一个键写两遍这类对不上的一个字不动。
- 「Default」那一行（`env.ANTHROPIC_DEFAULT_MODEL`）改成只在没写时补，写了别的型号不跟着改，同开机换下架型号（#1154 第 4 条）；
  `claude-model-picker.ts` 的判断收进新的 `claudeRelayModelPickerUpdates`，`claudeRelayModelPickerOutdated` 跟着它走。客户用 /model
  换了型号以后，「Default」不再在第二天自己跟过去。保存配置照旧把它写成当前型号。
- 定点改写的落盘（`commitProviderRewrite`）换型号、刷新菜单共用；每替换一个文件前都核一遍配置原文没变，变了整个退回。
