## 开发

- Windows 查「命令行工具开没开」（`electron/cli-process-probe.ts`）分清「查过了，没开」和「没查成」（深查 CLI运行解析 C-1）：
  探测脚本改在 `$ErrorActionPreference = 'Stop'` 下跑，列进程（`Get-CimInstance Win32_Process -ErrorAction Stop`）和逐个比对包在 `try` 里，
  走完才输出 `{"ok":true,"items":[…]}`，出错输出 `{"ok":false,"error":…}`。`parseWindowsCliProcessProbeOutput` 改回整个
  `CliProcessProbe`：只有 `ok:true` 且每一行都读得懂才算 `checked`；没输出、读不懂、旧格式、`ok:false`、有一行没有可用 pid 一律
  `unavailable`。以前 WMI 被关、坏了或没权限时 `Get-CimInstance` 只写错误不抛，在 `SilentlyContinue` 下回空列表、退出码 0，
  被当成「没开」，开机那轮补设置、按账号刷新 Codex 型号名单、换下架型号会在工具开着时照写；现在落到 `running-tools.ts` 的
  `unknown`，这几件事照「看不出来就先不写」推迟到下一轮。界面上的字不变。`e2e/windows-powershell-probes-smoke.mjs` 补一条：
  完整语言和受限语言两种模式下，替身 `Get-CimInstance` 写错误时回 `unavailable`，空目录照旧回 `checked`。
