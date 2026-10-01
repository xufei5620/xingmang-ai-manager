## 用户

- 网络时好时坏的电脑上，打开软件时偶尔先显示「暂时连不上，登录还在」、半分钟后才自己好：现在第一次没等到回应会隔几秒悄悄再试一次，期间照旧显示「正在恢复登录」，大多数情况下直接就登好了。

## 开发

- `realm-account-service.ts` 开机恢复（restoreActive 的非 stalled 分支）第一次超时（`RealmAccountError('TIMEOUT')` 或 `NewApiNetworkError('timeout')`）后隔 `startupRetryDelayMs`（缺省 3 秒）再试一次，两次都超时才 markStalled 交给 30 秒那一轮；联不上、维护等其他失败不快速重试。仍在同一个 transition 的 30 秒 prepare 期限里。起因：A014 反馈报告里历史账号站点约四次请求就有一次超 10 秒，开机恢复撞上就要挂 30 秒「暂时连不上」。
