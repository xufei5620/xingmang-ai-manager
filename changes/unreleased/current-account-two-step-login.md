## 用户

- 当前账号开了两步验证（手机验证器）的，现在能直接在软件里登录了：输完密码后会让你输验证器里的 6 位数字，手机不在身边也可以用备用码。以前只会提示去官网，登不进来。

## 开发

- 第十五批 1：`new-api-client.ts` 登录遇到 `require_2fa`（及上游改名后的 `require_verification` + `methods`，推测，按上游主干源码写）不再只抛错，改抛带私有 flow token 的 `NewApiTwoFactorRequiredError`（消息原文不变，冻结的旧界面照旧当报错）；新增 `completeTwoFactorLogin` 调 `POST /api/user/login/2fa`，成功后与普通登录同样落会话。`methods` 里没有可用 `2fa` 时照旧提示去官网。
- `realm-account-service.ts` 在内存里保管这一次的 flow token（最多 5 分钟，新登录、退出、用过即丢），新增 IPC 通道 `account:submit-two-factor-code`（只收验证码，入参与结果都不进运行日志）。输错、限流、锁定都还能接着输；服务端说会话过期才回到输密码。
- renderer-v2 登录框多一步输验证码 / 备用码；历史账号的两步验证仍指去官网。
