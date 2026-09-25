## 用户

- 买了订阅的客户：只要订阅还能用，首页不再挂着「余额只剩 $0.00，充值后可继续使用。」，钱包跌破 $5 也不再弹「余额需要留意」通知。首页余额卡、托盘菜单和侧栏会多一行「订阅：剩余 $X · M 月 D 日到期」。订阅 3 天内到期或剩不到 $5、而余额也不够时，首页改为提醒「去续费」。只用余额的客户看到的一切照旧。

## 开发

- 新增 `electron/subscription-summary.ts`（无 Node 依赖，已加进 renderer 边界门禁的 `valueImportable`）：`resolveUsableSubscription` 判断「有生效中、没过期、有剩余额度、扣费偏好不是只用余额」的订阅；new-api 的 `amount_total` 为 0 按不限额处理，Sub2API 取最紧的限额窗口。首页、`App.tsx` 跌破 $5 的通知和托盘共用这一个判断。
- 渲染层 `features/app/subscription-cache.ts`：不另起定时器，跟着余额每次读回顺带读一次 `account:get-subscription-self`，5 分钟内读过不再读；订阅没带名字时才读一次套餐列表。读失败保留上次结果。
- 主进程 `ipc.ts` 的 `account:get-subscription-self` 读成功后回调 `onAccountSubscription`，`main.ts` 存下来给托盘菜单和提示用（`traySubscriptionLabel`），换账号时清掉。没有新增 IPC 通道。
