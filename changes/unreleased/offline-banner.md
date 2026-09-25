## 用户

- 软件开着的时候网断了，窗口顶部会出现一条提示：「现在连不上网。已经装好的 AI 工具照常能用；充值、聊天、安装和更新要等网络恢复。」右边有「重新检测」。网络回来后这条提示自动消失，并自动补上断网期间没写好的 Key。
- 断网时点充值、兑换、安装工具、发送聊天消息，会马上提示「现在没网，等网络恢复后再试。」，不用再等半天才报错；聊天输入框里的内容原样保留。
- 断网时左下角余额不再显示「更新失败」，改成「没网，稍后自动刷新」。

## 开发

- 新增 `features/shell/online-status.ts`（断网判断唯一出处）、`useOnlineStatus.ts`（`OnlineStatusContext` + `navigator.onLine` 订阅）、`OfflineBanner.tsx`。断网 = `navigator.onLine` 为 false，或余额连续 2 次读取都是本机网络类失败（`network-failure.ts` 归类里的 offline / dns / proxy / intercepted；超时、连接被拒、证书、服务维护不算，那可能只是服务那一侧的问题）。
- `balance-store.ts` 快照新增 `networkFailures`（连续本机网络类失败次数，成功或其他失败归零，换账号归零）；系统 `online` 事件来时若有失败计数就马上重读一次余额确认。
- 从断网恢复（不论是 `online` 事件还是余额重新读成功）都会触发一次现有的 Key 补跑（`planOnlineResync` 去重）。
- 断网时 `App.tsx` 的 `install` / `installRuntime`、充值报价、兑换、聊天 `send`、搜索框领加速口令都先返回「现在没网，等网络恢复后再试。」。有网时行为不变。
