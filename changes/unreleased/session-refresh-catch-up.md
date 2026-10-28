## 用户

- 网络不稳时，不容易再被突然退出登录了。

## 开发

- 网络差时续登录被作废（10-27 排查「当前登录已结束」时读 new-api rc.44 源码发现的漏洞；那一单的主因是找回密码第 3 步的
  另一个空当，不是这个）：new-api 每次续期都换一把新的续期凭据，旧的只在 30 秒内还认（rc.44 `service/auth_token.go` 的
  `RefreshReplayWindow`，那 30 秒里拿旧的来会发回同一把新的）；过了 30 秒再拿旧的来就当被盗，整个登录当场作废
  （`refresh_reuse`，401 `AUTH_SESSION_REVOKED`）。续期发出去、服务器换了凭据、回话却丢在路上时，客户端手里还是旧的，
  下一次续期（常在几分钟后）就把登录弄没了。
- `new-api-client.ts` 的 `refreshCurrentSession` 改走新的 `refreshAllowingLostAnswer`：续期没等到回话（超时、连接半路断了、
  网关或服务回了 5xx）时，隔 2 秒拿同一份旧凭据补续一次；从第一次发出算起超过 20 秒就不补（留 10 秒给它走到服务器），
  也只补一次。同时要续期的请求照旧共用一次（`refreshInFlight`），补续也在这一次里，不会并发续期；等的那一下里登录换了、
  退了就不补。服务器回了话的（401、429）和根本没送到的（解析不出地址、证书、门户拦截、代理没放行）不补。开机恢复
  （`switchSession`）不走这里，它有 `restoreAllowingOneTimeout` 那一次补试。
- 登录结束记日志：服务器不认这次登录、本机跟着清掉登录时，运行日志记一行 `account/session.ended`（先被拒的请求、
  最后拒掉登录的请求、状态码、服务器回的 code、请求编号、线路，以及之前有没有续期没等到回话、补没补），补续本身记
  `session.refresh.retried`，来不及补记 `session.refresh.lost`。都不记凭据。`NewApiClientOptions` 新增 `log`（主进程在
  `bootstrap/accounts.ts` 接到 `runtimeLog`），401 时是哪个请求、回的 code 挂在 WeakMap 上，不加错误对象的字段。
- 历史账号（sub2api）的续期没动。
