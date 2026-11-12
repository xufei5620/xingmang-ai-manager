## 开发

- 深查·查余额和扣费显示 F1：订阅还没读到（刚登录、刚换账号）或第一次就读失败时，渲染层不再当成「没有订阅」。
  钱包 $0、靠订阅用的客户以前在这段时间里会看到首页「当前账号余额是 $0」那条、工具卡「余额为零」和「去充值」、
  侧栏「充值」后面挂「余额为零」、顶部余额变红、新手引导把「去充值」顶到最上面，读失败时一挂 5 分钟。
- `subscription-cache.ts`：`readAt === null` 就是「还没读到」；这个账号还一次都没读到时，读失败后 30 秒、1 分钟、
  2 分钟……最多 5 分钟后再试（`subscriptionFirstReadRetry`，仍然只跟着余额的读回触发，不另起定时器）；读到过的照旧
  5 分钟一次、失败了留着上一次的。`useUsableSubscription` 多返回 `subscriptionUnknown`。
- 不知道有没有订阅时：`buildBalanceRunway` 回 `{ usableUsd: null, days: null, low: false }`（不算天数、不挂「余额低」
  「余额为零」），`homeMoneyNotice` 回 null，`homeWalletEmpty` 回 false，新加的 `balanceTier`（从 `App.tsx` 那一行搬出来）
  对不到 $20 的钱包用中性档，侧栏账号卡不写「按量付费」。手机遥控卡的「余额快没了」读的是同一个档位，一并不提醒。
  跟主进程托盘、余额提醒的 `subscribed: null` 同一个口径。读到了、确实没有订阅的 $0 客户，原来的提示照旧出现。
- 顺带修了 `useUsableSubscription` 在开发版 StrictMode 下的老问题：effect 清理时直接 `cache.dispose()`，StrictMode
  马上重连的还是同一个缓存，从此订阅一次都不读（正式包没有这一遍，不受影响）；改成跟余额那份一样，最后一个使用者
  离开后才释放。以前这个问题被「读不到 = 没有订阅」盖住了，这次不修会变成开发版里永远「不知道」。
- 测试：`subscription-cache.test.ts`（没读到时 `readAt` 为 null、30 秒起翻倍重试、读到过的照旧 5 分钟、换账号重新数）、
  `balance-runway.test.ts`（不知道时不算天数、`balanceTier` 各档）、`Home.test.tsx`（$0 提示、工具卡、余额卡），
  `app-check.mjs` 新加一条：夹具 `subscriptionReadFail` 让订阅一直读失败，首页、工具卡、大卡、侧栏都不说「余额为零」。
