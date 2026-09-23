## 用户

- 更新页点「重启并安装」后直接关掉软件开始安装，不会再弹一次「要不要顺手装上更新」的关窗提问；开着加速时也会先断开加速、还原网络设置再交给安装程序。
- Mac 上更新下载完自动安装时，不会再弹出关窗选项把安装卡住。

## 开发

- 全面检测 Q3。`quitAndInstall` 最终走 `app.quit()`（Mac 上先关所有窗口），`window-lifecycle.ts` 把它当成用户关窗拦下：问一遍「安装并退出」，或者直接 `preventDefault` 让安装器超时报失败；另外安装器在 Windows 上会结束安装目录下的进程，`prepareToQuit`（断开加速、还原系统代理）根本来不及跑。`updater.ts` 新增 `prepareInstallQuit` / `installQuitAborted`：`main.ts` 接到 `lifecycle.prepareUpdateQuit()`，先跑完退出清理、放掉画布与支付窗口，再拉起安装器；安装没起来（准备失败、看门狗超时）时 `abortUpdateQuit()` 撤掉放行。已经在退出确认里选了「安装并退出」的路径不变，同步拉起。
