## 用户

- 打开工具前的模型核对只算当时那个账号的：核对途中切了账号，这次结果直接作废，不会拿上一个账号的结论去改新账号的默认模型，也不会再弹上一个账号的「换模型」提问。

## 开发

- #538：`tool-model-check.ts` 在模型列表返回后、刷新 Claude Code 菜单前都重新核对配置身份（站点、账号、Key、型号），变了就返回 `skipped`；`refreshPicker` 多收一个 `assertCurrent`，由 `system-service.ts` 作为 `saveConfig` 的 `assertBeforeWrite` 在落盘前再验一次。`tools:check-models` 纳入 `ipc.ts` 的账号工作门禁，切号会等它跑完并拒绝跨修订号的结果。renderer-v2 `App.tsx` 的打开流程按 `accountEpoch` 丢弃旧结果，切号时替用户关掉还开着的换模型弹框。
