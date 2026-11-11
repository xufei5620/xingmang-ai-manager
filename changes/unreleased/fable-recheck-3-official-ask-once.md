## 开发

- Fable 复查第一轮 3（2026-11-11 yoyo 批「切回官方问一句」）：0.2.24 之前接过星芒的配置快照里没有 `filled` 记号，切回官方账号以后
  `permissions.defaultMode = "bypassPermissions"` 照旧留着（D5 只撤记下的）。现在切回官方（首页一键切换 `config:switch-account-source`、
  配置窗口 `config:switch-to-official-account`）切成以后，Claude Code 还是官方账号的样子又还是 bypass、这台电脑又没问过
  （`AppSettings.claudeCommandConfirmationAnswered`，只落 true），结果里带 `askCommandConfirmation`，renderer-v2 弹
  `CommandConfirmationDialog` 问一次。用户可见的话并进了 `official-switch-withdraws-bypass.md` 那一条（用户行已满 60）。
- 新通道 `config:answer-claude-command-confirmation`（`ask` | `keep`）：`ask` 由 `restoreClaudeOfficialCommandConfirmation` 只撤
  `permissions.defaultMode = bypassPermissions` 和 `skipDangerousModePermissionPrompt = true`（`permissions` 撤空连键删），真要写才先做
  「设置 › 备份迁移」那份备份（同设置里两个 Claude Code 开关），配置这会儿又接着别的地址就抛错不改、不记问过；`keep` 什么都不改。
  两种都记问过，记不下只记日志。关掉框（Esc、右上角）当 `keep`；焦点落在「保持现在这样」，随手回车不改客户的设置。
