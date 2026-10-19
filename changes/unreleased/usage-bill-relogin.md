## 用户

- 打开「用量账单」时，如果服务器拒绝了其中某一项查询（用量看板、调用明细、异步任务或各工具累计用量），
  现在只在那一块说没读到，不再把整个账号退出来；以前每点一次都要重新登录，重新登录也没用。

## 开发

- `new-api-client.ts`：`getDashboard`、`getUsage`、`getTasks`、`listKeys` 改走 `withReadSession`。续期接口刚认过
  refresh cookie、拿新令牌重问还被回 401 时，只让这一次读取失败（`readRefusedAfterRefreshMessage`，挂着原来那次的
  状态码和请求编号进日志），不再 `setSession(null)`。续期接口自己拒了照旧清掉登录；`/api/user/self` 这类认身份的
  请求不变。触发是 yoyo 在 Windows 那台上点「用量账单」反复被要求重新登录（Mac 正常），哪一项被拒还要看那台的
  运行日志。
