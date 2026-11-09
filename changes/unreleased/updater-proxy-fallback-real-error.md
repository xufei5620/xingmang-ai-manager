## 用户

- 电脑的系统代理还指着一个已经关掉的代理软件时，检查更新、下载更新会自动改成直接联网再试一次，不再一直提示更新失败、新版本推不过来。

## 开发

- 修 PX-1 前半条（`0.2.24-深查/代理.md`）：`updater.ts` 的 `isProxyConnectionFailure` 只认 `error.code` 上的
  `ERR_PROXY_CONNECTION_FAILED`，可 Electron 的 net 模块（`net-client-request.ts`，electron-updater 检查和下载都走它）只
  `new Error('net::ERR_PROXY_CONNECTION_FAILED')`，不挂 code，builder-util-runtime 原样往上抛，所以「代理连不上就改直连
  重试一次」在正式包里从来没触发过。改成同时认「整句 message 恰好等于 `net::ERR_PROXY_CONNECTION_FAILED` 的 Error」，
  只认 Electron 自己构造的那种：多一个字、大小写不同、裹在 HttpError 正文里、普通对象或字符串都不算，原来防「镜像页、
  更新说明里提到这个词就绕开客户的代理」的用意不变；带 code 的照旧认，cause 链照旧最多跟 4 层。
- 测试里的假错误换成真实形状：沙箱里用 Electron 45.1.0 + electron-updater 6.8.9 对一个没在听的代理端口真跑了
  `checkForUpdates` 和 `downloadUpdate`，两处拿到的都是只有 `stack`、`message` 两个自有属性的普通 Error。旧判断下用这个
  形状有 11 条用例变红。另加「只有整句相等才算」的 8 种反例。
- PX-1 后半条（`autoUpdater.netSession` 跟着 `proxy-bypass` 一起改直连，盖住服务状态文件、在线节点）不在这里，另开。
