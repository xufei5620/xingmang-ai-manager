## 用户

- Mac 上开着「自动更新」时，退出星芒顺手装新版本改成等新版本准备好再退出，等的时候窗口先收起来，
  免得退出了却没装上、下次打开提示「上次没装上」。从这一版往后的更新生效。

## 开发

- `electron/window-lifecycle.ts`：`installDownloadedUpdate` 可以返回 Promise，`runQuit` 先 `hide()` 再等它落定，
  最多 20 秒，然后照常 `quit()`；安装器自己接手退出（will-quit 里 dispose）时不再叫第二遍。新增 `noteSystemPowerOff()`：
  关机、重启、注销时不等，免得系统说本程序取消了关机。
- `electron/main.ts`：只在 darwin 上返回 `waitForUpdateInstallFailure(updaterService)`（`quit-blocking-tasks.ts`），
  交出去前先放掉画布、支付窗口并 `app.hide()`；安装看门狗的 `UPDATE_INSTALL_LAUNCH_TIMEOUT` 不算落定（慢的 Mac 还在验签）。
  `powerMonitor` 的 `'shutdown'` 接到 `noteSystemPowerOff()`。
  以前退出路径把更新交给 electron-updater 的 `MacUpdater.quitAndInstall()` 后马上 `app.quit()`，而 Squirrel.Mac 要在
  本进程里从本机代理取包、解压、验签（10-2 真机日志约 1 秒）才自己退出重开，推测进程先退就什么也没装上。
  Windows、Linux 的安装器是独立进程，不变。真机还没核，步骤见 `/mnt/project-files/0.2.15-真机新增/`。
