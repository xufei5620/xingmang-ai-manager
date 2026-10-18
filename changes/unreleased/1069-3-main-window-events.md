## 开发

- 账号状态、付款结果（带订单号）、更新状态这三类通知改为只发主窗口，不再挨个窗口广播进画布和支付窗口（#1069 第 3 条）。
  画布换账号走自己的 `canvas-host:account-changed`，支付窗口不挂 preload，两边功能不变。`electron/main.ts`
  的 `sendToMainWindow`；新加的 `electron/main.test.ts` 读源码钉住主进程不再对所有窗口 `send`。
