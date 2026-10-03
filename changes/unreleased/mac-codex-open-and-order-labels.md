## 用户

- Mac 上 Codex 桌面端已经开着时，点「打开」会直接回到现有窗口，不再弹出「Codex 已在运行」——那里的「重启 Codex」在 Mac 上一点就报错。
  改了中文界面、换了账号以后，星芒会说清楚要先在 Codex 窗口里按 Command + Q 完全退出，再回星芒点「打开」，新设置才会用上；教程里也补了 Mac 的做法。
- 「我的订单」的支付方式显示「支付宝」「微信支付」这样的中文名，不再是 alipay、wxpay；「异步任务」详情里的状态和列表一样写「已完成」「失败」。

## 开发

- 第二十九批 A：`App.tsx` 的 `requestLaunch` 碰上 Codex 桌面端已在运行时，改由 `features/tools/codex-desktop-open.ts` 判断要不要弹
  「Codex 已在运行」，只有 Windows 弹。Mac 主进程一律拒绝 `restart`（`codex-desktop-service.ts`），框里只有「打开窗口」走得通，
  所以直接走 `open`（菜单栏和快捷键走的是同一条路）。`locale-status.ts`、`ConfigDialog.tsx`、`running-tools.ts`
  （`codexDesktopRunning === true && !canRestartCodexDesktop`）按 Mac 换成「Command + Q 完全退出再打开」的说法，Windows 文案不变；
  教程两个系统共用一份，三处各在句尾补半句给 Mac。`account-bound-launch.browser-check.mjs` 钉住 Windows 照旧弹框、Mac 不弹且只发一次 `open`。
- 第二十九批 B：`pages-account.tsx` 订单页的支付方式也走 `paymentMethodLabel`（#722 当时只改了充值页），任务详情的状态用和列表同一张 `taskStates`。
