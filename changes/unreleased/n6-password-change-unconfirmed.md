## 用户

- 在「账号安全」里改密码时网络断了，下次登录不会再给你填上旧密码。

## 开发

- 0.2.25 总单第 20 项（11-18 复核 N6）：星芒账号在个人中心改密码，`PUT /api/user/self` 已经发出去、服务端也存好了新密码，
  回话却没到（超时、连接被切断、网关 502/504、门户页），处理器只在成功时才改「记住密码」，于是本机记住的还是旧密码，
  下次登录自动填上就登不进。找回密码第 3 步那条路 #1481 已经靠「拿新密码试登」盖住，个人中心这条一直没有。
- `new-api-client.ts` 的 `changePassword` 多一个可选的 `onOutcome` 回调，报告改密码那一下走到哪了（`NewApiPasswordChangeOutcome`）：
  发出去之前报 `unconfirmed`；服务端明说没存（rc.44 `UpdateSelf` 存密码之前的那些拒绝：入参、安全凭证、原密码、密码规则，
  都是 500 以下、不带 `AUTH_` 开头错误码的 JSON；限流和网关在前面挡掉的不是 JSON 的 4xx）报 `refused`；明说存好了报 `changed`。
  存好以后还可能失败的那两步（`PublishUserAuthCache`、`AdvanceCurrentSessionToUserVersion`）走 `writeAuthSessionError`，
  回的是 `AUTH_*`（401/409/429/500），跟鉴权中间件在前面拒绝时用的同一套码，分不出来，所以不算明说没存。
  401 照旧续登录后整个重来一遍；前一遍没等到准话的，后一遍再被拒也不改口报 `refused`（多半是前一遍已经改好了，后一遍的原密码才对不上），
  只有明说存好了才算数。改密码本身照旧不自动重发。
- `ipc/handlers/account.ts` 的 `account:change-password`：失败时看回调报到哪一步。`unconfirmed`：本机记住的若是这个账号的，清掉，
  不留一个可能已经失效的旧密码，也不把没确认过的新密码当成功记下；`changed`（服务端已存好，后面登录换了人才报错）：照成功那样换成新密码；
  `refused` 或者根本没发出去：不动。认账号沿用 `rememberedLoginNamesAccount`，处理中换了账号不会清掉别的账号记住的登录。
  `relay-backend.ts` 的 `RelayBackendClient.changePassword` 跟着加这个可选参数，`realm-account-service.ts` 的代理原样转交，
  账号切走后结果被换成 STALE，处理器照样能知道密码已经改了。
- 历史账号不在这次范围：它的客户端把「原密码错误」和连不上都报成同一个 `NETWORK`，分不出有没有改上，`sub2api-relay-backend.ts` 也不改，
  所以它不报 `onOutcome`，失败时跟以前一样不动记住的密码。
- 用例：`new-api-client.test.ts` 按回话逐种钉住报告（成功、各种存之前的拒绝、断连、超时、502/504、存好后的 `AUTH_INTERNAL_ERROR`、门户页、
  401 后重来被拒、401 后重来成功）；`ipc.test.ts` 钉住处理器三种走向和不碰别的账号，其中「没等到准话就清掉」「已存好就记新密码」两条在旧代码上红；
  `realm-account-service.test.ts` 钉住账号切走后回调照样送到。
