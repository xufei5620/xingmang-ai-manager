## 开发

- 决定单 D32（代理深查 PX-11）：电脑设的代理要账号密码时，不再叫客户去开代理软件。`network-failure.ts` 加
  `proxyAuthRequiredMessage`（单子原句）、`proxyAuthRequiredStatus`（407）、`isProxyAuthFailure`（认 Chromium 的
  `ERR_PROXY_AUTH_UNSUPPORTED` / `ERR_PROXY_AUTH_REQUESTED*` / `ERR_UNEXPECTED_PROXY_AUTH`，或主进程已经写好的那句）和
  `resolveNetworkFailureMessage`；归类照旧是 proxy，改直连、重发那套一点没动。Electron 45.1.0 沙箱实测：走 https 时代理回 407，
  net.fetch 先交出 407 的回应、读正文才报 `ERR_TUNNEL_CONNECTION_FAILED`（跟「代理回绝了这个地址」同一个码），所以
  `new-api-client.ts` 还看这次回应的状态码；认证方式不认或没说时直接报 `ERR_PROXY_AUTH_UNSUPPORTED`。星芒账号
  （`NewApiNetworkError`）和历史账号（`RealmAccountError`）的报错换成这句；渲染层顶上横幅多一种 `proxyAuth`（还试一次直连、
  「打开系统代理设置」按钮照旧），登录框也认这句。不做输入代理密码的框。历史账号那一侧收到 407 回应照旧当成「请求失败」
  （不归网络），聊天、检查页、更新那几条路的说法也没动。
