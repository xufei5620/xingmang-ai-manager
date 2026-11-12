## 开发

- 花费突增提醒的 6 小时安静期改按「站点 + 用户编号」记（`0.2.24-深查/查余额和扣费显示.md` F8-2），不改字、不加通道、门槛不变：`balance-alerts.ts` 交给 `spend-spike.ts` 的 `account` 从 `String(userId)` 换成余额观察的 `scope`（`solov:123` / `solov-api:123`，跟余额用完那条记录同一个键）。以前星芒账号和历史账号的用户编号碰巧一样时，一边提醒过，另一边 6 小时内也不再提醒。
  `spend-spike-notified.json` 里旧版只按编号记的那条照旧算数：新键还没有记录时退回看旧键（`SpendSpikeObservation.legacyAccount`），升级前 6 小时内刚提醒过的不再说一遍；旧记录过了安静期就不再算数、读写盘时顺手清掉。通知的事件编号随之变成 `spend:solov-123:<时间>`。
