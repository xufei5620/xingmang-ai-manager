## 用户

- Windows 上开着游戏加速直接关机或重启，软件会先断开加速、把系统网络设置还原再让电脑关机（关机界面可能会显示几秒「星芒AI管理工具正在阻止关机」），下次开机不会再出现整台电脑上不了网。

## 开发

- 全面检测 Q2。Electron 收到 `WM_ENDSESSION` 后立刻结束进程，`before-quit` / `will-quit` / `prepareToQuit` 都不跑，系统代理只能靠后台辅助进程事后还原，关机那几秒基本来不及。`window-lifecycle.ts` 改在窗口的 `query-session-end` 上判断 `needsShutdownCleanup()`（`main.ts` 接 `acceleration.hasPossibleSession()`），需要时 `preventDefault` 推迟关机，按 10 秒预算跑完 `prepareToQuit`（`stopAll` 会等代理还原完才停内核）再退；没开加速不拦。原来挂在 `app` 上的 `session-end` 监听是死代码（它只在窗口上发），一并改到窗口上。
