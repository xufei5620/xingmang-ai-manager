## 开发

- `features/tools/recent-display.ts` 的 `formatRecentTime` 不再把 `updatedAt` 乘 1000：主进程 `provider-sessions.ts` 给的记录时间本来就是毫秒（`timestampMilliseconds` / `statTimestamp`），
  再乘 1000 落到几万年后，`formatCalendarTime` 的日历差 ≤ 0，全写成「今天 + 错的钟点」（0.2.22、0.2.23 都有）。记录页走的 `RelativeTime` 一直按毫秒读，不受影响。
  `recent-display.test.ts` 的夹具改按毫秒写，并加一条「上周的毫秒时间写日期、不写今天」的回归（改前 5 条红）。0.2.24 全面检查 K2。
