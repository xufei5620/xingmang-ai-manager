## 开发

- 开机自动换下架型号不再整份合并重写工具配置，只改型号那几处，文件其余字节原样（#1154 第 4 条）。以前 `tool-model-check.ts`
  的 `replaceRetiredModel` 借 `refreshPicker` 走 `saveConfig` 的 merge，模板里的每一项都按当前版本重写一遍：Codex 客户自己定的
  `review_model` 被换成新型号，Grok 指去别处的 `endpoints.xai_api_base_url` 被指回中转，Claude Code 删掉的 deny 项被补回，
  TOML 注释、JSON 缩进全冲掉。现在交给新的 `replaceModel` 依赖（`system-service.ts` 的 `replaceToolModel`），由
  `config-files.ts` 的 `planProviderModelReplace` / `applyProviderModelReplace` 定点改写，做法同换线路（`tool-route-rewrite.ts`）。
- 跟着改的只有本来就跟着型号走的：Codex 的 `review_model` 等于旧型号才换、`supports_websockets` 正好是旧型号该写的值才翻
  （同 `followCodexRelayWebsockets`，没写的不补）；Claude Code 的 `env.ANTHROPIC_DEFAULT_MODEL` 等于旧型号才换。Codex 配置本来就指着
  本软件的型号名单时，名单文件按新型号一起重写，先落盘、替换前原文变了就整个退回；该补上或收回那一行的这次不动，下次核对菜单时再说。
  Claude Code 的 /model 菜单也留到打开前那次核对再刷。
- 闸照自动写入那道：只认当前账号写的、没选官方账号的，写之前再核一遍账号、配置没变、账号确实能用新型号。来源记录不动：它认的是
  路径、地址和 Key，型号不在里面，换完照旧是「当前账号」，模板版本号也不跟着变。
- `tool-route-rewrite.ts` 加了 `rewriteTomlValues` / `readTomlBoolean`，能换开关值；原来的 `rewriteTomlStrings` 不变。
- 没改的：客户用 /model 自己选的型号要是也在下架名单上、账号也不再列它，照旧会换成同系列的（来源记录分不出型号是谁选的）；
  打开前刷新菜单那条（`refreshPicker`）照旧整份合并。
