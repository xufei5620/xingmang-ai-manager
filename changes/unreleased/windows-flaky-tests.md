## 开发

- Windows CI 里三处在 runner 忙时偶发超时假红的检查改成不依赖 PowerShell 冷启动或墙钟：
  `electron/cli-process-probe.test.ts` 的「real PowerShell probe」（Get-CimInstance 三次超过 60 秒探测预算）改成所有平台都跑的两半——
  注入 `runProbe` / 新增的 `resolvePowerShell` 检查交给 PowerShell 的参数与可信环境，再用 #454 的引号扫描器检查脚本只从环境变量读目录、两种进程形态都按序数比较；
  `scripts/windows-acceleration-recovery.test.cjs` 的逻辑测试本来就把原生读写全换成桩，不再现场 Add-Type 编译用不到的 WinInet 类型（多起一次 csc.exe，run 35885043224 超 30 秒），
  另加一条全平台检查保证恢复脚本与 `electron/platform/windows-system-proxy.ts` 的 WinInet 源码一字不差（真编译真改代理仍由 windows-uninstall-smoke 覆盖）；
  `e2e/renderer-v2-native-close-race.mjs` 去掉 5 秒退出墙钟（退出本身就允许 2 秒清理加 2 秒兜底强退，run 35892482024 超时），改为在主进程记录关窗事件，断言关窗走到自己的 before-quit、全程没向界面发退出询问，
  「不等界面」改由 `electron/window-lifecycle.test.ts` 在不推进任何时钟的前提下直接证明。
- 引号扫描器从 `codex-desktop-appx.test.ts` 挪到 `electron/powershell-script-scan.test-support.ts` 供多个测试共用；`tsconfig.electron.json` 排除 `*.test-support.ts`，不进 dist-electron。
