## 用户

- 登录时密码只会发给你这台电脑上记录的那个账号服务，被拒绝后不再自动拿同一个密码去试另一个。

## 开发

- E-B2：`realm-account-service.ts` 的 `login` 删掉双候选回退。站点现在只由调用方显式指定的
  `siteId`，或 `vault.preferredLoginSite(identifier)` 的确定性结果决定（都没有时回落 `solov`），
  一次登录只有一个后端拿到明文密码；原先邮箱标识符在第一个后端明确拒绝后会把同一份密码再 POST
  给第二个。后端自己的拒绝错误现在直接透出，不再被包成 `RealmAccountError('LOGIN_REJECTED')`。
- E-B15：`account:get-remembered-login` / `account:set-remembered-login` 传明文密码是有意的产品
  取舍（落盘走 `safeStorage`），在 CLAUDE.md 的 I3 下登记为显式例外，不改行为。
