## 用户

- 修复登录状态自动续期或付款后刷新余额时，游戏加速被误当成「换了账号」：不再弹「账号已变更，请重新打开游戏加速」，正在用的加速也不会被断开。

## 开发

- `main.ts` 的账号 `onChanged` 改为身份（站点 + 用户 + 会话代数）真的变了才调 `acceleration.onAccountChanged()`；此前任何登录态变化都会推进加速代数，在途的 get-state 报「账号已变更」并顺带停掉正在跑的加速。身份比较抽到 `account-identity-tracker.ts`，补单测。
