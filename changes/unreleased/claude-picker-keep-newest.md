## 开发

- Claude Code 的 `/model` 菜单在当前账号列着的 Claude 型号超过 20 个时，改成先舍掉老的（`claude-model-picker.ts` 的
  `buildClaudeRelayModelPicker` 改用 `sortClaudeModelsNewestFirst`，和 Claude 桌面端菜单同一套排法）。以前照模型接口的名字
  次序截前 20 个，`claude-sonnet-*` 排在最后，新上的 Sonnet 5、5.5 反倒先被挤掉。当前选定的型号照旧永远在内，放进去的照旧按
  名字排，不改界面文字。按老截法写的菜单仍认作本软件写的，下次刷新菜单时换成新的。yoyo 2026-11-12 回「1 2 3 做」里的第 3 条。
