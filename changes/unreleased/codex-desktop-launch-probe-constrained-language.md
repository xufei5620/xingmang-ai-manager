## 用户

- 修复部分开启了应用管控的 Windows 电脑上，Codex 桌面端已经打开、仍提示「未能启动」的问题。

## 开发

- 点「打开」后等 Codex 窗口的那条查进程脚本（`codex-desktop-service.ts` 的 `codexDesktopSessionProcessQuery`，
  `buildCodexDesktopSessionProcessProbeScript`）适配受限语言模式（WDAC / AppLocker 一类策略、`__PSLockdownPolicy`）：
  以前用 `[System.Diagnostics.Process]::GetCurrentProcess().SessionId` 问会话、用 `[pscustomobject]@{}` 出结果，
  受限模式下两句都被拒，脚本永远输出空，激活接口又因 `Add-Type` 被拒拿不到进程号，于是 Codex 经开始菜单那一路已经开在屏幕上，
  星芒等满时间仍报「Codex 未能启动」；「已经开着就不重开」的判断也永远是「没开」。现在跟 #1715 关窗前那条查法一样：
  FullLanguage 那句原样留着，受限模式改用 CIM 查本 PowerShell 进程（`ProcessId=$PID`）的会话，问不出就整条失败
  （打开那一路照旧当「没找到」，`probeCodexDesktopRunning` 照旧是「查不出来」），不去跑一个不带会话的过滤；
  结果改成 `[ordered]@{}`，FullLanguage 下 JSON 不变；输出走 `buildPowerShellJsonOutputStatements`，受限模式下非 ASCII 转 `\uXXXX`。
  不放宽任何策略。单测钉住受限模式那一半不含被拒写法；Windows 打包作业的 PowerShell 冒烟（`e2e/windows-powershell-probes-smoke.mjs`）
  用复制成 `Codex.exe` 的 node.exe 在两种语言模式下真跑这条脚本，要求找到同一个进程、JSON 相同。
  受限电脑上激活接口仍用不了（`codex-desktop-cdp.ts` 的 `Add-Type`），Codex 照旧退回开始菜单那一路打开，带不上工作区和中文补丁，这次不动。
