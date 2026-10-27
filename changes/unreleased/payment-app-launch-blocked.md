## 开发

- 支付窗口（#1458，Claude·win 在 A012 上查清）：乐风码付的收银台 302 落到 `/pay/<订单号>`、画完二维码以后，会无条件把页面跳去
  `alipays://` 拉起支付宝 App。支付窗口照旧拦下这一跳（放行规则不变）；0.2.21 还在等整页加载，被中止的加载报 `ERR_ABORTED`，
  就成了「支付页面打开失败」，0.2.19 起支付宝充值每次都这样。#1405 改成提交即打开以后这一跳只拦不报错，这次补上这个场景的单测
  （`payment-window.test.ts`，提交后跳 `alipays://`、`weixin://` 被拦、随后 `ERR_ABORTED`，窗口照常显示、不销毁、照常查单）。
- 拦下的是 `alipays:`、`alipay:`、`weixin:` 这类拉起 App 的地址时，`payment/navigation.blocked` 改记 info，只写协议名
  （新纯函数 `resolvePaymentAppLaunchScheme`），不再按 warn 记「已阻止支付窗口跳转到未授权地址」把客服带偏；
  别的被拦地址照旧 warn 记 origin。
