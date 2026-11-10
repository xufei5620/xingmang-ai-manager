## 开发

- D51（时间数字格式.md N-1）：`payment-window.ts` 自己画的扫码页（只有历史账号微信 Native 走这页）原先把
  `expiresAt` 的 UTC ISO 原样写成「有效期至：…Z」、金额后面跟币种代码。新加两个纯函数：`formatPaymentQrAmount`
  （CNY 写「元」，别的币种照旧写代码）和 `formatPaymentQrDeadline`（本机时间，当天「今天 HH:MM」、别的日子
  「M月D日 HH:MM」、跨年带年份，秒数舍掉）。跟渲染层 `calendar-time.ts` 的 `formatClockTime` 同一套写法，
  但那边把「不早于今天」都算今天，套到将来的到期时间上 23:50 下单、0:20 到期会写成「今天 00:20」，所以主进程另写一份。
  窗口按 `expiresAt` 到点关、扫页面倒计时的逻辑都没动；新那一行不会被当成「00:00」倒计时归零。
