## 用户

- 同一个账号反复重新登录，旧的登录会顺手在服务端注销掉，不会越攒越多，最后因为「登录设备太多」登不进去。

## 开发

- #476：`realm-account-service.ts` 的 `promote` 在输密码登录（`fresh`）提交成功后，注销被替换掉的同账号会话：当前客户端就是这个账号时用它自己的 `endServerSession`，否则（另一账号在用、开机恢复卡着）用本机账号库里被覆盖的那份凭据走新增的 `endSavedSession` → `new-api-client.ts` 的 `endPersistedServerSession`（只带 refresh cookie 与 New-Api-User，服务端按 cookie 注销）。登录成功但本机没存下来时当场注销那个新会话。切换已保存账号、开机恢复、密码错误都不发。业务代理不暴露新方法。线上注销接口是否接受这种只带 cookie、不带 Origin 的请求没法在沙箱里验证，要真机看个人中心「登录设备」数量。
- #487：`acceleration-service.ts` 读写加速线路/模式偏好前先核对是不是当前登录账号，读完再核一次，退出或切换账号之后到的旧请求一律拒绝。
