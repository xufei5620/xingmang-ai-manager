## 用户

- 星芒账号的用量账单选「24 小时」时，24 小时前那一小时里的花费不再漏掉，上面的花费、柱状图和下面的调用明细算的是同一段时间。

## 开发

- #1093 第 4 条：`features/account/usage.ts` 的 `usageRangeStart('1')` 从「现在往前 86400 秒」改成退到那一刻所在的整点。
  new-api 的 `quota_data` 只记到整点（`model/usedata.go` 的 `LogQuotaData`：`created_at - created_at % 3600`），
  `GetQuotaDataByUserId` 只回 `created_at >= start` 的行（rc.24、rc.44 与上游 main 一致）。起点落在 10:34 时，昨天 10 点那一行整个不回，
  10:34 到 11 点的花费看板上没有，按逐条时间查的调用明细却有。退到整点后两边查的是同一段，最长 25 小时，远低于上游
  `limitLogTimeRange` 默认 365 天的上限（「30 天」的调用明细本来就要一次查 30 天）。「7 天」「30 天」从本地零点起，不受影响。
- 同一处：`electron/new-api-client.ts` 的 `parseAccountDashboardData` 按小时分桶的跨度上限从 24 小时放到 25 小时。
  不放的话起点一退，跨度就过了 86400 秒，主进程改按天分桶，「24 小时」的柱状图只剩一两根（Codex 审查指出）。
  只有「24 小时」用桶画图，别处只取总数；「7 天」那几段每段不到一天，本来就是按小时。
