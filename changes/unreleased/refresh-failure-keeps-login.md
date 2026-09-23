## 用户

- 用着用着网络抖一下、服务繁忙或正在维护时，不会再被退出登录、要求重新登录；等网络恢复后余额和用量会接着更新。

## 开发

- `electron/new-api-client.ts` 的 `retryAfterSilentRefresh`：401 后静默续期失败时，只有续期接口明确拒绝凭据（`NewApiAuthenticationError`，含没有 refresh cookie）才清会话；超时、断网、429、5xx、维护保留会话并抛出续期自己的错误，与 `refreshAccessToken` 语义对齐。此前任何续期失败都会 `setSession(null)`，`realm-account-service` 随即把账号从本机账号库删掉。access token 15 分钟过期，续期接口与登录共用按 IP 的限流（校园网、公司网共用出口易 429），这条路径每天都在跑。
