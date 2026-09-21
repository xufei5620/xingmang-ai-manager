## 开发

- 文档：`docs/DUAL-REALM-DESKTOP-INTEGRATION.md` 的「登录与账号归属」一节按 main 上的实际逻辑重写。原文写的是
  「不显示平台选择器、主进程猜站、被拒后试另一站」，这套行为已被 #202（`ea544e2`，E-B2）取消：现在登录页有
  「账号来源」二选一（星芒账号 / 历史账号，默认星芒账号），`siteId` 永远显式传，明文密码只发给选中的那一个站，
  被拒即结束。同节补上注册只在星芒站、找回跟随来源、记住密码绑定来源、归属存 `realm-accounts-v2.dat` 的
  `realmId` 等当前事实，并与 `docs/RELIABILITY-AUTH-2026-09-18.md` 互相引用、各说各的范围。
- 文档：同一份文档「本地验证与边界」里 `automaticDetection: true` 那条标注为 2026-09-09 当时的记录，指向新一节。
- 文档：`docs/DUAL-REALM-IMPLEMENTATION.md` 的 D-01 说明原来只点名三个已删除模块，现在逐条给出它们当前对应的位置
  ——切换/登录/恢复在 `electron/realm-account-service.ts`，候选客户端桥接在 `electron/main.ts` 的 `createClient`
  工厂加 `electron/sub2api-relay-backend.ts`，能力投影在各后台自报的 `capabilities` 加
  `src/renderer-v2/account-context.ts`；表格里三个已删除模块的行也就地标了「已删除」。
