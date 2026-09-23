## 用户

- 在比较慢或管得比较严的 Windows 电脑上，软件确认不了自己是不是以管理员身份打开时，现在按普通用户处理，安装和打开工具照常能用，不会再因为「没确认出来」而全部失败。确实是以管理员身份打开的，仍然按管理员处理，「检查」页会说明原因，并提示直接双击重新打开。

## 开发

- 可能没想到的问题第 8 条（判定部分，yoyo 2026-09-23 同意「看不出时按普通用户处理」，取窄档）：`resolveWindowsCliExecutionModeDetailed` 在令牌提升类型探测失败时，按 whoami 完整性标签有没有读出来分流：读出 High 及以上仍回退 trusted-only；标签也读不出（含 whoami 失败、超时）时改为 same-user，`probeFailure` 照带。残余风险：以管理员身份打开、且 whoami 与 PowerShell 探测都失败的机器会在高权限进程里按 same-user 解析；检查页读实时令牌，这种情况仍提示普通启动。`cli.execution-mode.probe-failed` 日志文案与 `mode` 字段、检查页 `ADMINISTRATOR`（trusted-only + 失败给 warn 与「直接双击重新打开」，same-user + 失败给 pass 并在 details 留原因）、反馈报告「运行权限」一行都按实际模式说；trusted-only 不再有「或无法确认」这一说。
