## 开发

- 备份页恢复配置后，「选了官方账号」的记号和 Claude Code 的官方 Console Key 跟着恢复出来的那份对齐
  （#1080）：恢复的是当前账号的中转配置，就清掉官方记号、把 `~/.claude.json` 的 `primaryApiKey`
  挪进快照（不挪它会以 `x-api-key` 顶掉中转的 Key，一用就是无效令牌）；恢复的是官方登录的样子，
  就记成官方、把快照里的 Console Key 放回去。别家中转、半截的、工具自己读不了的不动。新增
  `system-service.ts` 的 `restoredAccountSide` / `alignRestoredAccountSource`，`ipc.ts` 的
  `backups:restore` 在登记来源后调用，失败只记日志；切换失败的回滚照旧自己恢复这两样，不走这里。
