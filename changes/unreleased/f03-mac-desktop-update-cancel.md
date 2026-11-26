## 用户

- 修复了 Mac 上更新桌面端的若干问题：点击「取消」后仍被更新、已自行升级的版本被换回旧版、更新后 Codex 桌面端未自动重新打开。

## 开发

- 0.2.25 总单第 36 项（11-18 复核 F03）：Mac 上更新 Claude Desktop、OpenCode、Codex 桌面端，下载核对完进了「放进应用程序」那一步以后，
  `electron/macos-desktop-app-installer.ts` 的 `replaceBundle` 和它调的关进程（`macos-desktop-app-update.ts` 的 `prepareMacosDesktopReplacement`，
  外部客户端那一路关进程时不带取消，最长要等 30 秒）都不再看取消，取消却照样接受：界面说「已取消」，装着的已经换成了新版。
- 现在 `replaceBundle` 在关它之前、关完之后各看一次取消，接受了就不换（旧版原样留着，旁边那份新版删掉）；看完最后一次同步调
  `MacosDesktopAppReplacement` 新加的可选 `onReplaceStarting`，两个调用方（`external-client-runtime.ts` 的 `updateOnMac`、
  `codex-desktop-service.ts` 的 `updateCodexDesktopOnMac`）在这里封存取消，之后点取消提示原有的「正在安装 …，这一步中断会留下装了一半的程序，请等它结束。」，
  不加新字。`prepareMacosDesktopReplacement` 多一个可选 `signal`，只在请它退出之前看：已经发过 SIGTERM 的照旧关到底。
- 没动「下载期间它自己升到更高版」那一条（F04，总单第 37 项，同一处，后开）。
