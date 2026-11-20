## 用户

- 窗口在托盘里放久了再叫出来，偶尔一片空白、只能重启星芒；现在再点开一次就会重新载入。

## 开发

- 11-18 复核 U05（0.2.25 总单第二档第 32 项）：缩到托盘关掉省内存的界面，重新加载那一下要是没成（`loadURL` 被拒，
  或加载到一半界面进程没了），`electron/renderer-release.ts` 一直停在 `restoring`，之后 show / focus 都不再加载，
  `reloadIfRendererGone` 也因 `restore('show')` 返回 true 拦住了崩溃恢复，存着的跳页一直发不出去，只能重启整个程序。
- 现在 `reload()` 把 `loadURL` 的 Promise 交回控制器（`main.ts`），失败或进程没了（`consumeExpectedExit` 返回 false 时）
  记 `renderer.restore.failed`（warn），状态仍是 `restoring`、存着的跳页留着，下次窗口出来再加载一次。每次加载有编号，
  被新一次顶掉的旧加载迟到的失败不算；失败了不自己接着重试，免得一直读不出来时反复拉起界面进程；也不退回 `released`，
  崩溃恢复那边自己重载成功时界面的报告照样能接住。再试那次不重算 `restoredBoot`、不再调 `onRestoring`。
