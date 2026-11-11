## 开发

- 给客户看的那一句并进了 `fable2-price-table.md` 的「## 用户」（一版最多 60 条，已满）。
- `electron/relay-sites.ts` 的站点表加可选字段 `invoicePortalUrl`（星芒账号 `https://invoice-xm.solov.cc/orders`、历史账号 `https://invoice-api.solov.cc/orders`，对应开票那边生产栈的 `INVOICE_PORTAL_ORIGINS`）。它只在软件里的开票窗口打开，不进外链白名单。
- 新增 `electron/invoice-portal-window.ts`：不挂 preload、sandbox、关 devTools，权限请求一律拒绝，导航、跳转只放行开票中心那一个 origin，新窗口一律拒绝，标题固定。开票中心的登录按账号各存一个持久分区（站点加用户编号的摘要），换人、退出时关窗口并清掉上一个人的分区。
- 下载发票只认开票中心页面自己的 `blob:` 地址、8MB 以内：先落到用户数据目录下的临时文件，按开头字节认 PDF、PNG、JPEG，再弹「保存发票」框，用 `writeAtomicSafeBinaryFile` 写到客户选的位置（I8）；哪一步不成都弹「发票没保存下来」那句。
- 新通道 `account:open-invoice-portal`（契约、preload、`ipc-channel-policy.ts`、`ipc/handlers/account-billing.ts` 四处）：入参为空，开哪个账号的开票中心由主进程按当前登录定，渲染层不给地址也不给账号。
- 界面上的六句字是 yoyo 2026-11-11 回「窗口改」批的原字（按钮、打开后的提示、窗口标题、打不开、保存框标题、保存失败框）。
