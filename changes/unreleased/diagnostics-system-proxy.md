## 用户

- 「检查」页的「电脑里的代理设置」现在也会看系统设置里开着的代理（Mac 和 Windows 都算）。开着别的代理软件或 VPN 时不再显示「正常」，会说明代理在本机哪个端口、星芒会跟着它走，连不上账号时先退出代理软件再试。

## 开发

- `diagnostics.ts` 的 `PROXY_ENVIRONMENT` 新增 `resolveAppProxy` 依赖：宿主交给 `session.defaultSession.resolveProxy(accountBaseUrl)`，即账号请求（net.fetch）真正走的路由，已含系统设置里的 HTTP / HTTPS / SOCKS / PAC，不起外部命令、不读注册表；解析复用 `download-proxy.ts` 的 `parseChromiumProxyResult`，本机端口复用 `probeLoopbackProxy` 试连。加速开着时不看（那是星芒自己设的）。详情只写本机端口或「别的机器」，不写地址（I13）。起因：2026-10-01 客户 Mac 开着别的代理，账号请求全超时，自检却报「没有另外设过代理」。
