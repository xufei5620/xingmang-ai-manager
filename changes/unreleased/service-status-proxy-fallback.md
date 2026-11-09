## 开发

- 修 PX-1 后半条（`0.2.24-深查/代理.md`）：服务状态文件（强制更新的最低版本、撤回名单、分批放量、维护提示、远程开关、
  付款方式开关、型号表）和检查更新走同一个 `autoUpdater.netSession`，可读它时代理连不上就直接当没读到，系统代理指着
  已经关掉的代理软件时一直读不到新的，强制更新推不到这台电脑。`readServiceStatus` 加可选的 `retryWithoutProxy` /
  `restoreProxy`：网络层报代理连不上时把会话改成直连再读一次（这一次另起超时），读完不论成没成都改回跟随系统代理；
  回了话但读不成的（404、网页、太大）、代理开着但回绝（`ERR_TUNNEL_CONNECTION_FAILED`）、超时、断网都不重试。
- 判断沿用 #1592 那份 `isProxyConnectionFailure`，从 `updater.ts` 原样挪到 `network-failure.ts`（`service-status.ts`
  不能反过来 import `updater.ts`），只认 Electron 原样抛出的整句 `net::ERR_PROXY_CONNECTION_FAILED` 或带 code 的错误。
- 检查、下载和状态文件现在是同一个会话上的两个用户，新增 `createSharedDirectRetry`（`updater.ts`）记着几个请求在直连上
  重试：最后一个试完的才改回 system，免得定时读状态文件那次先读完、把正在直连重下的安装包甩回关掉的代理。
- 沙箱里用 Electron 45.1.0 真跑过：`autoUpdater.netSession` 跟随一个没在听的代理端口时，`session.fetch` 报的是只有
  `stack`、`message` 的普通 Error；改直连以后马上重读就读得到，读完 `resolveProxy` 回到 `PROXY …`，两个读同时重试也只在
  最后改回一次。在线加速节点也走这个会话，但加速三个平台都下线了，没接。
