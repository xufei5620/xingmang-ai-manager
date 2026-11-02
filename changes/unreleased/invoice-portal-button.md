## 用户

- 个人中心「充值订阅 › 我的订单」多了「开发票」按钮：点了会在浏览器打开当前账号的开票中心，用这个账号的用户名（历史账号用邮箱）和密码登录后，按已到账的订单申请发票。

## 开发

- `electron/relay-sites.ts` 的站点表加可选字段 `invoicePortalUrl`（星芒账号 `https://invoice-xm.solov.cc/orders`、历史账号 `https://invoice-api.solov.cc/orders`，对应开票那边生产栈的 `INVOICE_PORTAL_ORIGINS`），`relaySiteExternalUrls` 顺带把它们放进外链白名单（全等匹配，I12）。
- `AccountOrders` 标题行加「开发票」，按当前账号用 `openExternal` 打开对应开票中心；只给地址、不带任何凭据，开票中心要客户在那边重新登录。提示与失败句是 yoyo 2026-11-02 批的原字（`recharge.ts` 的 `invoicePortalOpenedText` / `invoicePortalOpenFailed`）。
