## 用户

- 个人中心里改密码、找回密码后设新密码，又能改成功了。账号服务器升级后这两处一直改不掉密码。原密码填错时照旧提示「原密码错误，请重新输入」。

## 开发

- 账号服务器（new-api v1.0.0-rc.40）改密码多了一道安全验证：`PUT /api/user/self` 要在 `X-Security-Proof` 头里带一次性凭证，没带就回 403 `SECURITY_PROOF_REQUIRED`「需要安全验证」（`controller/user.go` UpdateSelf → `middleware/secure_verification.go` RequireSecurityProof）。星芒照 rc.24 写的只发了 PUT。`new-api-client.ts` 的 `changePassword` 先 `POST /api/verify`（`{method:'password', scope:'account.password.change', password:原密码}`）换凭证，再带着它 PUT；凭证只能用一次，每次改都重新换。rc.44 和上游 main 一样。
- 原密码错时 rc.40 回的是英文：验证那步 `SECURITY_VERIFICATION_FAILED`，PUT 那步 `CURRENT_PASSWORD_INVALID`。两处都换成 rc.24 自己的「原密码错误」，渲染层 `account-errors.ts` 原有那条认得它。开了两步验证的账号只能用验证码证明身份，验证那步回 `SECURITY_PROOF_METHOD_MISMATCH`，照原话交出去，PUT 不发。
- 直连线路的白名单（服务端 2026-10-06 文档 2.1 节）没有 `POST /api/verify`：选「自动」时直连回白名单 404 会当场改走默认线路（`relay-line-fetch.ts` 原有逻辑），选「只用洛杉矶」时改密码要等服务端把它加进白名单。
