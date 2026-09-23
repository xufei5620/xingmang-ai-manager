## 用户

- 这台电脑上已经存满 16 个账号时再登录新账号，现在会直接说「保存的账号已满」，并告诉你去「切换账号」里移除一个不用的；以前会误报成「安全存储不可用，请完全退出软件后重试」。

## 开发

- 全面检测 Q40。`realm-account.ts` 新增错误码 `ACCOUNT_LIMIT`，`realm-account-vault.ts` 的 `activate` 超出 16 个时抛它而不是 `STORAGE`；`realm-account-service.ts` 的 `restoreMayRecover` 把它算作不可自愈。渲染层 `authErrorMessage` 认出「保存的账号已满」后给同一句中文，排在「安全存储」判断之前。
