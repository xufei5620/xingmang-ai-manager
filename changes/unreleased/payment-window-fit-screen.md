## 用户

- 支付窗口按屏幕大小打开，屏幕小的笔记本上也能看全二维码和付款页。

## 开发

- 支付窗口（`payment-window.ts`）原来固定 760×820、最小 560×640。1366×768 的笔记本、1080p 开 150% 缩放的屏幕，
  能用的高度只有 680～730，窗口比屏幕高（推测会有一截压到任务栏下面或出屏，没在真机上看过）。新纯函数
  `buildPaymentWindowSize` 按窗口所在那块屏幕的工作区收：四周各留 16，最大还是 760×820，最小尺寸跟着收，免得被撑回去；
  读不到屏幕照旧。窗口建好、还没显示时由 `main.ts` 传进来的 `resolveWorkArea`（`screen.getDisplayMatching(...).workArea`）
  取那块屏幕，先 `setMinimumSize` 再 `setSize`，显示前照旧 `center()`。不传 `resolveWorkArea` = 旧行为。
