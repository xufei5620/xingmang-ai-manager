## 用户

- 打开了「启动时自动检查环境」的用户，开机不再把刚检测过的东西再查一遍：Node.js、npm、
  Python、Git、四个命令行工具的版本、PowerShell 和 Codex 桌面端，直接用首页刚检测出的结果，
  配置差的电脑上开机更轻快，首页和检查页的结论也不会再因为两边同时检测而对不上。在检查页
  点「重新检测」时照旧全部重新查。

## 开发

- `diagnostics:run` 新增可选参数 `{ reuseRecentScan?: boolean }`（不加通道，`parseDiagnosticsRunOptions`
  严格校验），只有 renderer-v2 开机那次自动检查传；检查页与 legacy 不传，行为不变。
- 主进程取 `systemService.recentScan(60_000)`：正在跑的那轮扫描就等它，一分钟内跑完且之后安装队列
  没动过就直接用，都没有就照旧自己探，不为此新起扫描。`createScanCoalescer` 为此返回
  `{ scan, recent }`。
- `runDiagnostics` 的 `recentScan` 依赖：运行环境、四个 CLI、Codex 桌面端从快照回答，扫描里
  `detectionFailed` 的项仍自己探；Windows 上 Codex 桌面端那次探测成功即证明
  `resolveWindowsPowerShellExecutable` 选出的 PowerShell 可用，`SYSTEM_POWERSHELL` 只取路径不起进程。
- 沙箱（Linux，未装 CLI）实测一次自动检查：自己探 124~169 ms，复用扫描 8~10 ms；Windows 上省下的是
  4 个 `--version`、1 次 PowerShell 和 Codex 桌面端那次合并探测（预算 24 秒）。
