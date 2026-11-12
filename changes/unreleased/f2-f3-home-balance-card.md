## 开发

- 首页余额卡两条（`0.2.24-深查/查余额和扣费显示.md` F2、F3），不改字、不加通道：
  - F2：订阅额度会按天、按周或按月恢复（`UsableSubscription.resetsAt` 有值）时，`buildBalanceRunway` 不再拿这一期剩下的去除日均，返回同不限额订阅的 `{ usableUsd: null, days: null, low: false }`；`subscriptionWarning` 也不再为它说「订阅只剩 $x」，只在快到期时提醒。以前每天 $10 的订阅、每天用 $8 的客户每天下午被说「不到 1 天就会用完」、侧栏挂「余额低」。这一期赶不到到期前再恢复（`resetsAt` 为 null）的照旧按一次性额度算。
  - F3：`Home.tsx` 读用量和近 7 天的两段 effect 跟上余额的 `updatedAt`（一分钟缓存照旧挡着），余额旁边的刷新先 `invalidateBalanceUsage()` 再一起重读；缓存刚作废、手上已有数时不先清空，卡片不闪。以前一直停在首页时「近 7 天花费」和「约还能用 N 天」停在进首页那一刻。
