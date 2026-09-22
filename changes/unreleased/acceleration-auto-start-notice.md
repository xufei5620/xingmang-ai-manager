## 用户

- 打开 Codex 桌面端时如果星芒替你自动连上了加速，现在会弹一条通知告诉你，托盘和加速页也会标出「自动连接」。关掉桌面端加速不会跟着断开，不用时记得在托盘或加速页断开，免得白白用掉免费时长。

## 开发

- 第十批候选 3。`AccelerationState` 新增可选字段 `autoStartedBy?: 'codex-desktop'`，缺省即旧行为（用户自己连的）。
- `acceleration-service.ts` 新增 `startAutomaticAcceleration(scope, origin, mode, lineId?)`，不进 `AccelerationApi`，渲染层没有通道能冒充这个来源；服务按账号记住软件连上的那次会话（认 `connectedAt`，开始前已在跑的不算），此后这次会话的每一份状态都带上标记，会话结束或换成另一次连接即清掉。
- `codex-desktop-acceleration.ts` 新增 `onAutoConnected(state)`，只在确实由它连上且已 `active` 时回调；主进程据此发 `accelerationAutoStarted` 系统通知（沿用 `acceleration` 偏好键，同一次连接去重）。托盘显示「已自动连接」，加速页在连接说明处写明关掉桌面端不会断开。
- 关掉桌面端仍不自动断开（沿用 #322 的决定）。未新增 IPC 通道。
