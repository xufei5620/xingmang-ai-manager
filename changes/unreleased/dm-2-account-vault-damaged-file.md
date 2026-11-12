## 开发

- 账号库文件本身坏了（空文件、截断、不是 Base64、坏道读出的乱码，或解得开却不是 JSON 对象）也算「读不懂」：客户主动点登录、手上又没有登录态时，照解密失败那套留一份 `realm-accounts-v2.dat.unreadable-*.bak` 再换空库，以前只认 `decrypt`，这台电脑就永远登不上，只能找客服远程删文件（数据和迁移 DM-2）。新增失败阶段 `parse`；`validate`（是 JSON 对象、只是版本或字段认不出，多半是退回旧版读到新版的库）照旧不动，开机、切换账号、退出也照旧不重建。`decode` 前去掉首尾空白和 BOM，记事本打开再存过的文件照常读出。`vault.recovered` 日志的 `reason` 改为实际原因（`decode` / `decrypt` / `parse`），不再写死 `decrypt`。`electron/realm-account-vault.ts`、`realm-account-vault-file.ts`、`vault-recovery-notice.ts`、`bootstrap/accounts.ts`，规则见 `docs/ACCOUNT-VAULT-RECOVERY.md`。
