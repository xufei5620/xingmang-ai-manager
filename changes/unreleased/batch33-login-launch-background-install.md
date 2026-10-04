## 用户

- Mac：设了开机自动启动、开机后一直没点开窗口的，上次下好的新版本会在开机几分钟后在后台装上，装好照旧待在菜单栏里，不弹窗口。要输开机密码才装得上的电脑，或者开机后已经从菜单栏开了加速的，开机时不装，留到退出星芒时再装。
- 开机自动启动后几分钟内点开窗口的，上次下好的新版本也会像平常打开时一样，先提示再自动装上。

## 开发

- 开机自启时「打开时装」从来不会发生：`update:startup` 要等开机安静期（3 分钟）过了才查更新，`decideLaunchInstall`
  只认从进程启动算两分钟内下好的。现在开机拉起的从安静期结束才开始算这两分钟（`main.ts` 的 `launchInstallClockFrom`），
  普通打开照旧从启动算。`launchedAtLogin` 和 `startupQuiet` 挪到打开时装的订阅之前建，别的用法不变。
- `auto-update-install.ts` 新增 `resolveLaunchInstallMode`：开机拉起、窗口一直没显示过的，能无人值守装（`canInstallUnattended`）
  又没开着加速就在后台装（'background'：不发预告通知、不摆卡、不等 5 秒），否则开机时不装（'skip'，日志 `install.on-launch.held`），
  其余照旧先预告再装（'notice'）。Windows 的 NSIS 是 perMachine，安装器每次都要 UAC 授权窗口，所以 Windows 开机时一律不装；
  Mac 照 Squirrel.Mac 的 `launchPrivileged`（SQRLUpdater.m：解开符号链接后 .app 或它所在的文件夹不可写就要管理员密码）看一遍，
  从磁盘映像或系统的只读临时副本里运行的也不装。
- 自动更新记录加可选的 `backgroundInstall {version, startedAt}`：后台装、安装器 10 分钟内重新拉起的那一次
  （`isRelaunchAfterBackgroundInstall`；ShipIt 装没装成都会拉起，所以不看版本）照开机拉起办，窗口留在菜单栏、走安静期，
  日志 `install.background.relaunched`；读到就清掉，只认一次。旧版本读这份记录会忽略这个字段。ShipIt 用
  NSWorkspaceLaunchDefault 打开会把程序切到前台，这一次在 ready-to-show 后 `app.hide()` 把前台还回去。
