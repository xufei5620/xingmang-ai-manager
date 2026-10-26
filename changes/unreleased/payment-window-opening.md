## 开发

- 充值、买订阅的支付窗口（`electron/payment-window.ts`）：yoyo 10-26 报「打开充值比较卡，支付页没弹出，拉起支付时星芒卡死」。
  三处原因都在 Electron 43 里真跑复现过：一是 `openTarget` 等 `loadURL` 整页加载完才算打开，付款页上一个脚本、一张图卡在半路，
  `account:create-topup-payment` 就一直不返回，「打开支付窗口」一直转，窗口里的查单也不开始；`<head>` 里的脚本卡住时
  `ready-to-show` 也不来，窗口一直不出现。二是易支付先给一张自动跳转页，这张页没加载完就跳去收银台时 `loadURL` 报 `ERR_ABORTED`，
  收银台明明打开了却被当成「支付页面打开失败」关掉。三是窗口带 `modal`：Windows 上主窗口整个被禁掉，Mac 上变成没有关闭按钮的 sheet，
  付款页卡住时客户关不掉，主窗口里的「关闭支付窗口」也点不到。
- 现在以主框架第一次提交（`did-navigate`）为打开，提交之后 `loadURL` 再失败不算数（新纯函数 `waitForPaymentPage`）；
  提交前失败照旧报打不开，30 秒（`paymentPageOpenTimeoutMs`）还没提交按 `ERR_TIMED_OUT` 报「支付页面打开失败，请稍后重试」；
  提交后 1.5 秒（`paymentWindowShowFallbackMs`）还没画出第一屏也先把窗口亮出来；窗口仍挂在主窗口上，但不再是模态。
  导航白名单、权限、下载、查单规则都没动。界面文字没改。
- 给客户看的那句等 yoyo 回「支付说明改」再挪进「用户」：「充值和买订阅时，支付页面弹出更快，偶尔弹不出来的问题修好了；
  支付窗口开着时星芒照常能用，Mac 上的支付窗口也能直接关掉。」
