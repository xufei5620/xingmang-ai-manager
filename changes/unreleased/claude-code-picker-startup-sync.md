## 开发

- 开机那轮也给 Claude Code 对一遍 `/model` 菜单（`config-save-service.ts` 的 `syncClaudeModelPicker`，走
  `tool-model-check.ts` 的 `syncPicker`，同 Codex 那条）。以前只在保存配置、从星芒点「打开」（隔一天一次）和
  老配置补备用型号那一次刷新，从终端或 VS Code 直接开 Claude Code 的客户，站上新上的型号一直进不了菜单。
  只碰本软件用当前账号写的配置；只改菜单那几处（`claudeRelayModelPickerUpdates`：菜单、没写过的「Default」、
  没写过也没被删过的备用型号），客户选的型号、自己写的菜单和备用型号不动；型号已下架的留给换型号那条。
  菜单已经是新的只多问一遍中转，不看工具开没开；要写之前 Claude Code 开着或看不出就跳过这一次、不记成欠着，
  写前先备份，失败只记日志。
