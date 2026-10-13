## 用户

- 注册时填的邮箱不在账号服务允许的范围里（比如这种邮箱后缀不收），点「获取验证码」以后会直接说这个邮箱暂时不能用来注册、请换一个常用邮箱，不再只说「发送验证码没有成功」。

## 开发

- new-api 从 rc.40 起，发码前邮箱后缀不在白名单、或带 `+` / `.` 的别名被禁时，`GET /api/verification` 回 HTTP 200 + `code: EMAIL_ADDRESS_REJECTED` + 固定英文「This email address is not allowed by the administrator's email policy.」（rc.40、rc.44 的 `service/email_binding.go` `ErrAccountEmailRestricted`，rc.40 就是英文；rc.43 起带的 `message_key` 就是这句英文，`electron/new-api-messages.ts` 按约定不收 rc.40 本来就回英文的句子，所以升级前后都到渲染层的还是英文）。renderer-v2 `features/auth/account-errors.ts` 那条邮箱限制原来只认带 whitelist / 白名单 / alias / 别名的旧说法，碰不上这句，注册框落到兜底「发送验证码没有成功，输入已保留，请稍后重试」。现在把这句英文和上游网页 zh.json 的中文「此邮箱地址不符合管理员设置的邮箱规则」也算进去，显示原有那句「这个邮箱暂时不能用来注册，请换一个常用邮箱（如 QQ 邮箱）再试」，没写新字。
