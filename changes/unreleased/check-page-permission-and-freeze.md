## 用户

- 检查页「运行权限」在慢电脑上不再显示红色的「检查超时」：现在一眨眼就能查完，万一电脑太忙没查完，也只是提醒稍后再看，不当成故障。
- 平时用管理员账号、但没有以管理员身份打开软件的电脑，检查页和安装失败的提示不再误说「这个 Windows 账号不在管理员组」。
- 在检查页点「重新检测」，窗口不再卡住几秒到十几秒。
- 用过「C 盘搬家」一类工具的电脑，检查页和导出的报告里只说文件夹被搬到了哪块盘，不再带出含用户名的完整路径。

## 开发

- `inspectWindowsElevationCapability` 改用 `System32\whoami.exe /groups /fo csv /nh` 判断账号在不在 BUILTIN\Administrators（S-1-5-32-544）：原 PowerShell 探测读的 `WindowsIdentity.Groups` 会跳过 deny-only 的组（.NET Framework 与 .NET 源码都是 `SE_GROUP_ENABLED|LOGON_ID|USE_FOR_DENY_ONLY` 掩码只收启用的组），UAC 过滤后的管理员因此被判成 standard。输出里没有恰好一个强制完整性标签时答 unknown，不猜。
- 诊断的「是否以管理员运行」默认探测先读完整性标签（`inspectCurrentWindowsProcessHighIntegrity`，High 及以上算是），读不出才退回原 PowerShell `IsInRole`；两次 whoami 各限 3 秒。检查项新增可选的 `timeoutOutcome`，「运行权限」超时给 warn 提醒而不是 error。启动时的执行模式判定（从严）没动。
- 诊断的 node / npm / git 版本探测与 CLI 版本探测在同步的 `isTrustedHighIntegrityExecutable` 之前先 `await primeTrustedHighIntegrityExecutable`，Program Files 下的 ACL 探测不再在主线程同步起 PowerShell。
- 「文件夹位置」一项的 summary 与 `toN` 只写盘符（`describeRelocationTarget`：`D 盘` / 共享文件夹 / macOS 外接磁盘名 / 别的位置），不再写 realpath 出来的整条路径——它带用户名，而脱敏只认原用户目录。
