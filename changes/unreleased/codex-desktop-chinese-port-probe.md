## 用户

- 修复 Windows 上用星芒打开 Codex 桌面端时，有时接不上中文界面、提示「未确认中文界面生效」的问题。

## 开发

- `codex-desktop-cdp` 的调试端口归属查询：开头按名字导入 Utility、NetTCPIP（收紧环境下靠自动加载要整套扫描，
  CI 上跑满 10 秒上限），末尾补 `exit 0`（端口还没人监听时 `Get-NetTCPConnection` 的「找不到对象」被
  `SilentlyContinue` 压住，但 powershell.exe 仍以 1 退出，「尚未就绪」变成整次中文增强中止）。真错误在
  `$ErrorActionPreference = 'Stop'` 下仍先于 `exit 0` 退出。问题自 #179 起就有。
