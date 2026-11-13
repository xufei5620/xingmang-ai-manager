## 用户

- 在官方账号和当前账号之间来回切，各自选的型号都会留着：Claude Code 官方那边自己设的默认型号（比如 Opus），切到当前账号再切回官方后还在；在当前账号上选的型号（比如 Codex 用的省钱小型号），切回过官方再改用当前账号时也照旧用它，不再悄悄回到默认型号（账号里没有这个型号了才换成默认的）。
  Grok 切回官方账号时，停在另一条线路上的旧设置也一起清掉，不会再界面上说切好了、实际还在用当前账号的额度。

## 开发

- 0.2.24 深查「反复切换」N4：Claude Code 接当前账号时 `parsed.model` 直接换成星芒型号，切回官方 `delete parsed.model`，
  官方那边的型号没人记。现在接当前账号前 settings.json 是官方账号的样子（没有 `ANTHROPIC_AUTH_TOKEN`、也没有
  `ANTHROPIC_BASE_URL`，口径同 `restoredAccountSide`）时，`claudeOfficialModelToKeep` 把顶层 `model` 记进同一份快照
  `xingmang-claude-foreign-settings.json` 的 `settings.model`（`moveClaudeForeignSettingsAside` 多一个可选参数，不动 settings），
  切回官方由 `restoreClaudeForeignSettings` 放回，同 env 那几项：settings 里已有 model 以现有为准，放完清空快照。
  接着星芒或别家中转时不记（那是中转的型号），所以接着当前账号再保存不会把记下的官方型号换掉；官方那边没设过就照旧删。
  merge、reset 两条都接上。
- 同上 N5：首页「改用当前账号」（`ipc/handlers/config.ts` 的 `writeAccountConfig`）调 `configureManagedClis` 时第 4 个参数一直是
  `{}`，切回过官方再切回来就挑默认型号。现在交 `accountSourcePreferredModel`（`account-source-switch.ts`）算出的原型号：
  配置本来就接着当前账号这个站（手填、别的账号）用它现在的型号；不是就用切回官方前记下的。记的地方是
  `AppSettings.relayModelsBeforeOfficial`（每家一条，只有主进程写，`settings:save` 的解析器不收），由
  `switchToOfficialAccount` 在切之前按 `relayModelBeforeOfficialSwitch` 取（配置连着当前账号这个站的任一条线路才算），
  切成以后写入；写不进只记日志 `official-switch.relay-model-unsaved`，不让这次切换失败回滚。没记过的 Codex（这条记号出现
  之前切的）退到星芒存的那份当前账号配置里的 `model`（`readStoredCodexRelayModel`）。新增 `SystemService.relayModelBeforeOfficial`
  （可选）。它只是「原来的型号」：账号不再列它时 `resolveDefaultCliModel` 照旧按系列和默认挑。
