## 用户

- 电脑里开着代理、但星芒经它连不上时，星芒会自己把账号和 AI 对话改成直接连接。这时「检查」页「电脑里的代理设置」
  改说「星芒经它连不上，账号和 AI 对话已经自动改成直接连接，不用关掉代理」，不再标黄、不再叫你退出代理软件；
  设置里「网络连接」那颗小标签也写明账号和 AI 对话已自动改成直接连接。

## 开发

- 已知30：`diagnostics.ts` 的 `withAppProxyRoute` 多收一个 `siteDirect`（宿主经新依赖 `siteDirectActive` 交
  `proxyBypass.siteDirect()`），系统代理开着或在别的机器上、且连星芒的请求已改走直连会话时换说法、这半不再标黄；
  代理没开的那种、另外设过代理的那半照旧。`platform/system-service.ts` 的 `describeSessionProxy` 多收一个
  `siteDirect`，经 `proxy-bypass-bridge.ts` 新增的 `proxySiteDirectActive` 接到 main.ts。
