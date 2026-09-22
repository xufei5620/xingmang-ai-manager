## 用户

- 备份列表和预览会标出这份备份里的 Key 是当前账号的、别的账号的，还是没有 Key；要恢复一份不是当前账号 Key 的备份时，确认框会先提醒一句。
- 恢复备份后首页马上显示恢复出来的配置，不用再手动「重新检测」；首页也不会再把刚恢复的配置当成「配置被改过」。
- 恢复完成后会当场测一次这个工具的连接，结论就显示在备份页上。

## 开发

- 第八批候选 4。`electron/backups.ts`：v2 清单新增可选 `key`（Key 的 SHA-256 与当时签发它的账号 id / 用户名，旧版本读到直接忽略），摘要新增 `keyOwnership` / `keyAccountName`，从不带 Key 或摘要跨 IPC（I3）；`ConfigRestoreResult` 新增 `provider`。
- `electron/ipc.ts`：`backups:*` 按当前登录态只读已有的 Key 缓存，算出账号上下文传给备份库；`backups:restore` 成功后调用新的 `systemService.adoptRestoredConfig`，把恢复出来的配置登记为账号来源（Key 正是当前账号签发的那把）或手动来源（其余），首页不再误报 `changed`，自动写 Key 也不会覆盖它。登记失败只记日志，不影响恢复结果。
- 渲染层：`BackupsPage` 新增 `onRestored`（App 接到 `toolbox.refreshConfig()`）与恢复后的 `checkProviderConnection` 结果条；归属文案收口在 `features/tools/backup-key.ts`。没有新增 IPC 通道。
