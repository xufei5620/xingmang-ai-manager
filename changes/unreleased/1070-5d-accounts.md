## 开发

- 拆 `main.ts` 的启动回调（#1070 第 5 步，第四批）：两个账号站点的登录记录和账号客户端原样搬进 `electron/bootstrap/accounts.ts`。`createAccountStorage` 是原来按系统能不能加密选保管、建登录记录那一段；`createAccountClientFactory` 是原来写在 `createRealmAccountService` 里的 `createClient`，连同账号请求经系统代理没走通时改直连重发的那个函数。换账号、退出时各服务怎么收拾（`quiesce`、`onChanged`）牵着整个应用，留在 main.ts。前后逐行比对：多出来的只有文件头、依赖参数和取主窗口那一句。
- 测试：`main.test.ts` 的启动顺序加上这两步（在注册协议之后、建账号服务之前）。新增 `bootstrap/accounts.test.ts`：系统不能加密时日志里照实说、Linux 上只留本次运行也不写账号文件、Windows 和 macOS 上不退到只留内存；两个站点各建各的客户端，建的时候不发请求；星芒账号的客户端不恢复、也不结束历史账号的登录。
