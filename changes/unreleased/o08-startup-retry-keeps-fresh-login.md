## 用户

- 修复了启动时网络不佳期间重新登录同一账号后，下次启动被退出登录的问题。

## 开发

- 0.2.25 总单第 19 项（11-18 复核 O08，全面检查 A-1）：开机恢复联不上、挂着「等自动重试」时，客户自己又登了同一个号。
  重试那次续期晚回来，`electron/bootstrap/accounts.ts` 的 `onCredentialRotation` 只按账号编号找记录、不看它还是不是出发时那份，
  把旧登录换来的凭据写进本机，盖掉了刚登的；内存里是新登录，重启后拿旧凭据恢复，服务端已经注销了它，就被退出来。星芒账号和历史账号两边都会。
- 账号库多一个 `rotateCredential(owner, expected, next)`（`electron/realm-account-vault.ts`）：比较和写在同一步里，
  记录里还是 `expected`（这次续期交出去的那份）才换成 `next`，已经是别的登录就不动、回 `superseded`，只换凭据、记录里别的字段不动。
  星芒账号的客户端续期时把交出去的那份作为 `onCredentialRotation` 的第二个参数一起给（`electron/new-api-client.ts`）；
  历史账号的客户端不改（`sub2api-relay-backend.ts`），在 `accounts.ts` 里记着它手上那份。被拦下时运行日志记
  `account/session.rotation.superseded`（只记站点，不记凭据），晚回来的候选照旧由 `retryStalled` 丢掉。
- `realm-account-service.ts` 的 `keepRotatedCredential`（重试接不上时把换来的凭据写回）原来先读再写，那次登录正好落在两步中间也会被盖掉，改用同一个方法。
- 用例：`electron/bootstrap/accounts.test.ts` 用真的账号客户端和账号库、假的网络走一遍「开机联不上 → 重试续期卡住 → 客户登同一个号 → 续期回来 → 重启」，
  两个站点各一条，在旧代码上都红（库里留下的是旧登录的凭据）；`realm-account-vault.test.ts` 补了这个方法的用例和一条随机输入用例。
