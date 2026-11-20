## 开发

- 刷余额不再整页重画（总单 77，深查「性能和资源」R8）：`App.tsx` 根组件不再订阅余额快照，
  `useAccountBalanceStore` 只建和管那份 store；侧栏账号卡、状态栏、低余额标签由新的 `AccountMoneyProvider`
  （`features/app/account-money.tsx`）算好交给 `AccountMoneyView` 里的外壳，页面元素在根组件里先建好原样传下去；
  首页余额卡拆成 `HomeBalanceCard` 单独订阅转圈和读失败，首页本身只挑余额对象。读回来跟上次一样时 store 留着
  上一份余额对象，首页的用量、近 7 天重读和 `useRunwayUsage` 也只在数变了时才换。改前每分钟那次刷新是
  3 次提交 × 131 个组件（393 次），改后 2 次提交共 114 次，根组件、首页、工具卡不动；手点刷新从 400 降到 180。
  `app-check.mjs` 加一条用 DevTools 钩子数重画的回归用例，在旧代码上会红。订阅到期这件事改跟订阅缓存
  （最多 5 分钟）一起重算，不再跟着每分钟的余额刷新。
