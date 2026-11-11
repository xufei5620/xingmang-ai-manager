## 开发

- Fable 手机遥控 YF-20：每条等你同意的除了 10 分钟到点自动拒绝那个定时器，另起一个在还剩 3 分钟时
  （`approvalReminderMs`）发 `approvalExpiringMessage`，只发一次；回过了、被拒了、渠道关了（`settle`）一起清掉。
  用户行并在 `codex-remote-fixes-0224.md`。
