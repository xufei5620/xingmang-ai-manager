## 用户

- 打开 Codex 桌面端时，加速改为在后台悄悄连上：不再弹「已为 Codex 桌面端连上加速」的通知；这次自动连的加速意外断开、网络已恢复时也不再提醒。网络可能没恢复时照常提醒。托盘和加速页仍会标出「已自动连接」，关掉桌面端后照旧自动断开。

## 开发

- `codex-desktop-acceleration.ts` 去掉 `onAutoConnected` 回调，主进程不再发 `accelerationAutoStarted` 通知，该通知种类一并删除；测试用 `@ts-expect-error` 钉住这个口子不再出现（yoyo 2026-10-01 定「悄悄连」）。
- `acceleration-interruption-notice.ts` 记下会话是否 `autoStartedBy`：自动连的会话意外断开且网络已改回（restored）只记 `acceleration.interrupted.quiet` 日志；unrestored 照旧提醒。
- 教程「为什么有时会自动连接？」与通知设置说明同步到现状（原文还停在「开始计时、关掉不会断开」）。
