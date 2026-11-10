## 开发

- 画布完善第 2b 条第 1 步（桌面那半）：画布宿主桥加一条只读通道 `canvas-host:get-account-summary`，不收任何参数，`capabilities().features.accountSummary` 改成开。回答只有五个字段：`siteLabel`（星芒账号 / 历史账号）、`accountLabel`（打码的账号名：留前一两个字和最后一个字，中间一律三颗星；历史账号拿邮箱顶用户名时只留 @ 前第一个字，域名也不给）、`balanceUsd`（`quota / quotaPerUnit`，跟主窗口一样）、`subscriptionLabel`、`readAt`；没登录回 `null`。邮箱、用户编号、密钥都不给。
- 余额用托盘和余额提醒同一份（主窗口、主进程本来就在读的那份），新记一个读到的时间；画布问的时候这份超过 15 秒才替它读一次站点，一次只读一次，画布问得再勤也最多 15 秒读一次，读失败也照样回上次读到的；读回来时换了账号就不记。不为画布另起定时器（`canvas-account-summary.ts`）。
- 画布上的余额条随下一次内核同步进来，那时再写「用户」那条。
