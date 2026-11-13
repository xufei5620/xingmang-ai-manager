## 开发

- 深查 IC-6（查图标和图片素材）：充值页和买套餐弹窗的付款方式，没有现成标志的渠道（QQ 钱包、Creem、Waffo 这类）以前画问号圆圈，
  现在画中性的银行卡（lucide `CreditCard`，跟「余额支付」那颗钱包一样大）。支付宝、微信支付、Stripe 照旧画自己的标。报告建议 QQ 钱包用
  simple-icons 的 QQ 标，这次没加：不新加第三方商标图，QQ 钱包也画银行卡。不改字。`AccountRecharge.tsx` 导出 `PaymentMethodIcon`，
  新加 `AccountRecharge.test.tsx` 钉住三家画自己的标、其余渠道不画问号。
