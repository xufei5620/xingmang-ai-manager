## 用户

- 登录框更清爽：默认就是星芒账号，「历史账号」收进底部一行「用历史账号登录」，老用户点一下就能切过去。
- 注册少想一件事：用户名会自动取邮箱 @ 前面的部分，想换可以直接改；万一这个名字已经有人用了，会直接指到用户名那一格让你换一个。
- 邀请码收成一行「有邀请码？」，有才点开；从邀请链接打开注册时仍然自动填好。邮箱框的提示改成「常用邮箱（如 QQ 邮箱）」。

## 开发

- 第十一批候选 4、5（`src/renderer-v2/features/auth/AuthFlow.tsx`）。「账号来源」Segment 默认收起，只有 `initialSiteId` 不是星芒站或用户点了 `auth-source-expand` 才出现；点它会同时选中历史账号。默认站点、只发选中那一站、注册只在星芒站都没变。同意勾选框与「记住密码」默认不勾保持原样（协调者拍板）。
- 用户名由 `state.ts` 的 `usernameFromEmail` 从邮箱派生：按码点截到 20 位（new-api `Username validate:"max=20"`，无字符集限制）；用户亲手改过就不再跟随，清空后重新跟随。`validateRegistration` 的长度校验同步改为按码点计数，与服务端一致。
- 注册撞名（`isUsernameTakenError`，与错误表共用一条正则）不再只出一条通用错误，而是把错误挂到用户名那一格并聚焦。
- `account-errors.ts` 补一条邮箱域名白名单 / 别名限制的中文文案：new-api 默认不开这项，RECON 也没记，确切措辞未核实，只在「邮箱」旁出现「白名单 / 别名」时命中，避免误吞别处的白名单报错。
- 邀请码折叠为 `register-invite-toggle`；带邀请码打开时直接展开。确认密码保留。
- 测试：`state.test.ts`、`account-errors.test.ts` 补单测；`browser-check.mjs` 新增四条浏览器用例，原有切来源的用例改走 `chooseAccountSource` 帮手（`e2e/realm-account-smoke.mjs` 同步）。
