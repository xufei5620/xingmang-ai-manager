## 用户

- 新建或修改密钥时，若分组列表读不出来，现在会直接说清原因：登录已过期、请求太频繁、
  账号已被封禁各有各的提示，不再一律显示「分组读取失败，请刷新后重试」，
  省去反复点刷新却始终存不了密钥的情况。
- 充值与订阅页长时间停留时，支付结果回调不会再偶尔漏接，订单不会卡在「等待支付结果」上。

## 开发

- R-G5：`src/renderer-v2/pages-account.tsx` 里 `refreshGroups` 的无参数 catch 改为
  `errorMessage(cause, '分组读取失败，请刷新后重试。')`，沿用 R-S7 那套脱敏入口。
  这是 v2 生产代码里最后一处把真实原因丢掉的 catch，而 `groupsError` 是保存密钥的硬门槛。
- R-G5：`src/renderer-v2/business-common.tsx` 的 `errorMessage` 补一条限流分支
  （`HTTP 429` / `too many requests` / `rate limit`），复用 registry 里既有的
  `errors.tooManyRequests`。此前服务端的英文限流原文会掉进通用兜底，被说成「请重试」。
- R-B6：同文件 `AccountRecharge` 的支付回调订阅改为只依赖 `api`，回调本身从 ref 取最新
  （与本文件 `refreshGroupsRef` 同一写法）。此前 `acceptPaymentTerminal` 的 useCallback
  依赖了每次渲染都新建的 `changed`，余额 store 每 30 秒 publish 就退订重订一次；
  把 `changed` 包成 useCallback 挡不住，因为 App.tsx 传下来的 `onAccountChanged`
  本身也是行内箭头。
- `e2e/v2-business.test.mjs` 增两条浏览器用例：分组失败按原因给不同文案（登录过期／限流／
  封禁／认不出时的兜底），以及多次重渲染只订阅一次支付回调且仍能结掉待支付订单。
  夹具的 `keyGroupsHarness.failNext` 现在接受错误原文，另导出 `paymentTerminalSubscriptions`
  与 `rerenderFixture`。
