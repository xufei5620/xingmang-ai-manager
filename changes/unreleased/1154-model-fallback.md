## 开发

- 挑默认型号时，默认、上一代都不在账号列表里，Claude Code 和 Grok 不再拿按字母排的第一个（#1154 第 1 条）：`electron/cli-model-defaults.ts`
  的 `resolveDefaultCliModel` 先在原来那个型号的系列里挑（Sonnet 换 Sonnet），再在默认、上一代的系列里挑，同系列取版本最新的；
  还挑不到时 Claude 按 Opus > Sonnet > Haiku，Grok 照旧取第一个。新配工具、打开前劝换、配置窗口预选都走这条。Codex 的兜底不变。
- 开机自动换下架型号改用新的 `resolveRetiredCliModelReplacement`：那是不问客户直接写，Claude Code、Grok 只换成默认、上一代或同系列的，
  只剩别的系列（比如只有 Sonnet、Haiku 的分组里换掉下架的 Opus）这次不换，记一条 `tool-models.retired-kept`，留给打开前那一问让客户点。
  Codex 照 0.2.19 起换 gpt-5.5 的老规矩。
- 打开前劝换（`tool-model-check.ts` 的 `check`）把配置里原来那个型号交进去，劝换也先留在它的系列里。
- Claude Desktop 检测完预选型号（`external-client-defaults.ts` 的 `detectedClientModel`）改用同一套挑法：「保存并检测」以前会按字母序
  直接存成 Haiku，现在是 Claude Code 的默认，没有默认时 Opus > Sonnet > Haiku（#1154 附录，#1059 残留）。
- 开机按账号刷新 Codex 型号名单、换下架型号时，写之前再看一眼 Codex 命令行和桌面端开没开，开着或看不出就这次不写，
  和 Claude Code、Grok 那条一样（#1154 第 5 条）。`syncPicker` 的 `beforeRefresh` 可以是异步的。
