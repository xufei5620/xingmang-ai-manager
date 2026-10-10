## 用户

- 新装星芒、第一次注册账号时连不上的，现在不用再等：以前软件开机直接定在洛杉矶线路、没先确认这台电脑连不连得上，连不上的人注册会失败，还要等约一分钟软件才改走 CF 线路。现在第一次开机只要洛杉矶一次没连上，就立刻改走 CF，注册不再卡在这一分钟里。连得上洛杉矶的电脑和以前完全一样。

## 开发

- `relay-route-controller.ts`：这台电脑还没有给某个站存下过结论时（全新安装），开机那一轮直连第一次健康检查没通过就直接查默认线路，不等 `relayRouteFailureThreshold` 那三次、也不等中间两段 `relayRouteFailureProbeGapMs`。最坏退回时间从约 60 秒降到一次检查超时。
- 为什么这样不削弱防横跳：三次阈值和 15 秒间隔防的是「在两条都能用的线路之间来回切」（2026-10-07 线上，见文件头注释）。**全新安装的电脑还没定过任何线路，没有可横跳的对象**，那套等待在开机第一轮只剩代价——而新用户的注册恰恰发生在这几十秒里（#963）。`SiteState` 新增 `everConcluded`，`settle()` 里置为 true，所以**只有开机那一轮**走这条捷径，定下线路之后这次运行里后面的检查照常走三次阈值；新增用例 `goes back to the three-check rule once the first launch has settled a line` 钉住这一点。
- 直连健康的机器行为完全不变，仍然只探一次：捷径只在直连那一次没通过时才多查一次默认线路。曾试过开机并发探两条，因为会让直连健康的大多数机器白付一次请求而放弃。
- 原来钉「全新安装也等三次」的四条用例改为断言新行为；`moves to the default line only after direct fails three health checks in a row and the default line answers`（带 `conclusions: { solov: 'direct' }`）原样保留，三次阈值的覆盖仍在。
- 没有改注册请求本身的重试：注册和发验证码会发邮件，`new-api-client.ts` 的 `mayReplayOffProxy` 只允许「可证明从未到达服务端」的失败重放，这条界线不动（0.2.15 修过「一下收到两封邮件」）。
