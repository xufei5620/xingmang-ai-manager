## 用户

- Windows 开机更快：检测 Codex 桌面端时不再同时起三个 `powershell.exe`，改成一条脚本一次问完，任务管理器里少两个进程、少一次全机进程枚举；检测结果和以前一样。

## 开发

- `electron/codex-desktop-service.ts`：`inspectCodexDesktop` 原本用 `Promise.allSettled` 并发跑 `findCodexDesktopStartApp`（`Get-StartApps`）、`listCodexDesktopProcesses`（`Get-CimInstance Win32_Process`）、`inspectCodexDesktopPackage`（`Get-AppxPackage`）三条独立的 PowerShell，现在合成 `buildCodexDesktopCombinedProbeScript()` 一条脚本、一次输出 `{ startApps, processes, package }` 一份 JSON。三段查询文本由 `codexDesktopStartAppsQuery` / `codexDesktopProcessQuery` / `codexDesktopPackageProbeStatements` 与原来的独立脚本共用，不会各改各的。
- 段内失败仍然隔离：脚本里每段各自 `try/catch` 写 `startAppsError` / `processesError` / `packageError`，`parseCodexDesktopCombinedProbeJson` 把每段交回合并前那个解析函数（`parseStartAppsJson` + `selectCodexDesktopApp`、`parseWindowsProcessesJson`、`parseCodexDesktopPackageProbeJson`），一段失败不会把另外两段清空，也不会把「没看成」当成「确认没装」。
- 合并后 `ConvertTo-Json` 多嵌套一层，显式 `-Depth 6`；`$ErrorActionPreference = "Stop"` 只在放在最后的 Appx 段里设，前两段沿用默认的 `Continue`。
- 总超时 `codexDesktopCombinedProbeTimeoutMs = 24_000`，取三段旧预算（各 8 秒）之和——串行跑之后谁都不比合并前更紧，避免低配机上把装好的 Codex 桌面端误判成没装。整条脚本失败（超时、起不来进程）走 `buildCodexDesktopCombinedProbeFailure`，三段一起回退且 `detectionFailed` 照常亮起。
- `findCodexDesktopStartApp` / `listCodexDesktopProcesses` / `inspectCodexDesktopPackage` 三个函数本身保持不变，安装、卸载、等待进程退出等路径照旧调用它们；本次只换掉开机扫描那一处。
- `electron/codex-desktop-service.test.ts`：合并脚本形态（三段查询齐全、三段各自 catch、`-Depth 6`）、解析三段齐全 / 确认没装 / 三段各自失败 / 非 JSON / 空输出 / 整体超时，以及整体超时后 `buildCodexDesktopWindowsProbes` 仍报 `detectionFailed`；另有 `it.runIf(win32)` 真跑一次合并脚本、断言输出可解析且 Appx 段必有结论（只有 Windows CI 会执行）。
