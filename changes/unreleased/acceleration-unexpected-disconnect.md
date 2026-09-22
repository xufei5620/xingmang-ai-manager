## 用户

- 加速中如果加速意外断开（比如被杀毒软件结束了），星芒会先把网络恢复正常，再弹一条通知告诉你，托盘上的加速那一行也会马上跟着变。以前这种情况软件不吭声，严重时整台电脑上不了网，要重新打开星芒才好。
- 设置里的「加速时长提醒」改名为「加速提醒」，关掉它同样不会收到意外断开的通知。

## 开发

- 第十批候选 2。内核退出：backend 新增 `onRuntimeInterrupted`（`notifyRuntimeExit` 与 `inspect` 两条路径都会报，停止失败也报），worker 转成只有事件名的 `runtime.exited` 诊断事件，host 新增 `onRuntimeExited`。
- 辅助进程被硬杀：host 记住收到过 `start` 的 worker，它不是本软件让它走的却退出了，就当场 `ensureReady()` 重拉一个（初始化即还原系统代理，不重连加速），结果经 `onHelperExited(recovered)` 报给主进程；重拉出来的 worker 没连过加速，再退出不会接着重拉。
- 新模块 `electron/acceleration-interruption-notice.ts`：收到上面两种报告后读一次状态（经服务 `onState` 推给托盘），读到会话确实停了才发「网络已恢复正常」，读不到或停不下来有限次重读后发「网络可能暂时连不上」；只提醒本次运行里看着连上的会话，同一次连接只提醒一次。通知沿用 `acceleration` 偏好键，新增 `accelerationInterrupted` / `accelerationInterruptedUnrestored` 两条主进程通知。
- 加速页上意外断开的那句改为「加速意外断开了，网络已恢复正常，可以重新连接。」。未新增 IPC 通道。
