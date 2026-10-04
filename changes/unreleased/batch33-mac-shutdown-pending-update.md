## 用户

- Mac 上新版本下好后没退出星芒就直接关机、重启或退出登录，下次打开星芒会自动装上新版本，不再一直提示「新版本上次没装上」；关机时也不会再被「关闭星芒AI管理工具」的提示框拦住。

## 开发

- 第三十三批 A：Mac 的 powerMonitor 'shutdown' 现在和 Windows 的 query-session-end / session-end 一样算「系统要关机」。
  `window-lifecycle.ts` 的 `confirmedQuit` 关机时不调 confirmQuit、不拉安装器；关机通知之后系统来让程序退出（before-quit）时，
  开着的关窗询问框、退出确认框不等回答直接按退出走（`answerUnlessPowerOff`）。以前 Mac 关机照「退出时顺手装」那一套先写
  `quitAttemptedVersion`、拉起 Squirrel 又不等它，安装器被一起结束，之后每次打开都说「新版本上次没装上」，这一版也不再自动装；
  关着自动更新时确认框还会拦住关机。Electron 43.6.0 只在 NSWorkspaceWillPowerOffNotification 时发 'shutdown'，Command + Q 和
  程序坞「退出」走 terminate: 不发（对过 electron_application_delegate.mm、electron_application.mm），普通退出照旧装。
- 关机被别的程序拦下取消时 Electron 不再通知，所以关机只管通知后 60 秒内开始的退出（`powerOffQuitWindowMs`），之后照常问、
  照常装；只听到通知、系统没来让程序退出时，开着的框留给用户答。
- `decideQuitInstall` 加 `systemShuttingDown`，关机时回 'later'（不装、不问、不记）；`main.ts` 的 confirmQuit 等完撤回名单、
  等完通知各看一次新加的 `lifecycle.isSystemShuttingDown`，`quitAttemptedVersion` 挪到等完通知之后才写。刚退出、记录已写、
  安装器还没装完时才关机的：收拾那一两秒里不再拉起安装器，`onPowerOff` 用 `undoQuitInstallAttempt` 撤回这次写的记录
  （尽力而为，没写成就和以前一样）。下次打开走现成的启动时自动装。
