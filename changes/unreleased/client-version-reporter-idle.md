## 开发

- `client-version-reporter.ts` 的 `idle()` 改成先等正在跑的那一次上报（`inFlight`）再等队列：
  上报成功后记「已报」的那次写盘要等请求回来才排进队，旧写法只等调用那一刻排着的，会在这次写盘还没落地时就兑现。
  `client-version-reporter.test.ts`「waits before the first report and pulls it forward after a sign-in…」
  在 macos-test 上 afterEach 删临时目录偶发 `ENOTEMPTY`（#2128）就是这个：用例结束后那次原子写还在往目录里放临时文件。
  新加一条在旧代码上每次都红的用例；`idle()` 只有测试在用，客户端行为不变。
