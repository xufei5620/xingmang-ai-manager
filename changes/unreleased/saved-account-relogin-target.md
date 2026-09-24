## 用户

- 切换到登录已过期的保存账号时，点「重新登录这个账号」会直接打开这个账号的登录框、填好账号名，历史账号不会再被带到星芒账号那边去登。

## 开发

- #480（审计 D06，0.2.10 由 #428 引入）：`SavedAccounts.tsx` 的重登按钮带上 `savedAccountLoginTarget(account)`（来源 + 用户名），`App.tsx` 用新的 `authTarget` 状态传给 `AuthFlow` 的 `initialSiteId` / `initialIdentifier`，关框或登录成功即清空，其它入口照旧打开默认的星芒账号登录框。`onLogin` / `openLogin` 改为可带可选 `LoginTarget`，原先直接 `onClick={onLogin}` 的几处包一层，避免把点击事件当成目标传进去。
