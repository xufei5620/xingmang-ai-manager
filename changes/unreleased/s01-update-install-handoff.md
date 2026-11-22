## 开发

- 审查总表 S01（0.2.25 总单第四节 W13，设计由 Claude·win 牵头）：更新安装从校验到执行全程用同一份安装包，期间有变化就不装；取消和失败后可以再装。
  Windows 正式版不再调用 electron-updater 的 `quitAndInstall`，改由新模块 `electron/windows-update-handoff.ts` 与随包脚本
  `build/update-handoff/verified-install.ps1`（`electron-builder.config.cjs` 的 `win.extraResources`）完成交接；
  `updater.ts` 记下核对用的校验值（`verifiedPackage`），安装前按它再核一次，交接结果分「核对通过、安装包有变化、取消、失败」四种处理；
  `bootstrap/updates.ts` 接线，`main.ts` 退出时安装在 Windows 上等交接结果（`quit-blocking-tasks.ts` 的 `waitForWindowsUpdateHandoff`）。macOS 与 Linux 的安装路径不变。
  提权不经 electron-builder 带的 `resources\elevate.exe`（CI 实测它把参数重新用空格拼起来、引号全丢，参数一长就退出 1 不启动）：
  系统 PowerShell 以普通权限跑脚本的 `-Relaunch`，脚本逐个加引号后请 Windows 以管理员身份再起一份自己，授权窗口点「否」时退出 1223。
  发起的那个 PowerShell 不 detached 起（`runHiddenWindowsProcess`，隐藏窗口、等它退出）：CI 上 detached 起的系统 PowerShell 不跑脚本就以 0 退出。
- 新字（确认词「更新交接字改」）：取消授权、安装包有变化、准备好却没能自动关闭、上次安装程序报了失败，共四句，见 `updater.ts` 开头那几个常量。
- 用例：`updater.test.ts` 新增「Windows install handoff (S01)」一组（旧代码上红）；新增 `windows-update-handoff.test.ts`；
  `quit-blocking-tasks.test.ts` 补退出时等交接的四条；`verify-packaged-hardening.test.cjs`、`ci-workflow-config.test.cjs` 各补一条；
  脚本本身由 Windows 打包作业的 `e2e/windows-update-handoff-smoke.mjs` 真跑（照星芒的发起方式走完整条路子的正常安装，参数不对时不请求提权，校验值不对、大小不对、安装程序失败、状态文件名被占）；`windows-self-upgrade` 先拿打出来的包里那份脚本单独走一遍。
- 升级冒烟（`upgrade-smoke.yml`）在 Windows 上加一项 `windows-self-upgrade`：要测的包自己升到同一次提交出的、版本号高一位的包，
  新的安装路子在打出来的安装包上从头到尾走一遍（旧版本升新版本走的还是旧版本的老路，测不到它）；
  `scripts/ci-change-scope.cjs` 的 `upgradeSmokeFiles` 加上交接模块和脚本两个文件。
- 没做：Linux 交给系统安装程序那一段按同一要求另开一条跟进；#1410 第 2 条（自动安装失败一次就不再自动装这一版）不在这次范围，自动安装的重试策略不变。
