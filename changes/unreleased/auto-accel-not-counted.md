## 用户

- 打开 Codex 桌面端时软件自动连上的加速不再扣免费加速时长，免费时长用完了也照样会自动连上；关掉 Codex 桌面端一两分钟内会自动断开。自己在加速页或托盘点开的加速照旧计时、照旧不会自己断开。

## 开发

- 自动加速不计入免费时长（yoyo 2026-09-30 定）：`acceleration-development-backend.ts` 新增 `startAutomaticAcceleration`，会话带 `billed: false`，不写账本 `startedAt`、不定到期、停止时不结算，时长用完也放行；状态带 `autoStartedBy`。host / worker 新增 `start-automatic` 通道（不进 `AccelerationApi`，渲染层要不到不计时的连接）。
- `codex-desktop-acceleration.ts` 连上后每分钟问一次桌面端还在不在（`probeCodexDesktopRunning`：Windows 走会话进程探测、macOS 走 osascript，查不出来记 null 不当「已关」），连续两次不在或连续十次查不出来就断开；只断自己连的那一次，用户停过或重连过就不管。
- 加速页、托盘、到期提醒与通知文案跟着改：自动连接期间剩余时长不倒数、不触发「还剩 5 分钟 / 已用完」提醒。
