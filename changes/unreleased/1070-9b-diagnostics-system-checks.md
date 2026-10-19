## 开发

- 拆 `diagnostics.ts`（#1070 第 9 步，第二块）：「系统与权限」那五项（星芒版本、操作系统、电脑芯片、运行权限、打开工具用的命令窗口）连同只有它们用的 `defaultInspectAdministrator`、`defaultInspectPowerShell`、`operatingSystemSummary`、`buildWindowsArmSummary` 搬进新文件 `electron/diagnostics-system-checks.ts` 的 `buildSystemChecks(context)`；`runDiagnostics` 的检查清单里那五项换成 `...buildSystemChecks(context)`，次序不变。新文件只 import `diagnostics.ts` 的类型（`CheckOutcome`、`CheckDefinition` 为此加了 `export`），搬走的两个导出名 `diagnostics.ts` 照旧转出。
- 搬运用脚本按原文件行号整段复制，逐段比对一字没改；`buildSystemChecks` 开头用一次解构把上下文里的名字照原样接回来。Windows 专属的几段原样搬过去，没改：问「是不是管理员」先用 whoami 读完整性标签、读不出再起 PowerShell（`defaultInspectAdministrator`），读 PowerShell 版本只用 `resolveWindowsPowerShellExecutable` 给的可信路径、跑在 `trustedCommandEnvironment` 下（`defaultInspectPowerShell`），有首页扫描结果时 PowerShell 那一项只取可信路径不起进程，启动时那次探测没问出来、管理员身份、账号自带管理员、普通账号不在管理员组这几种运行权限的说法，ARM 电脑读 node.exe 文件头看是哪一版。
- 测试：这五项的行为由 `diagnostics.test.ts` 原有的用例钉着（Mac、Linux、认不出的系统、ARM、管理员和提权的几种、命令窗口），上一块加的次序测试照旧绿；另用八种情况把整份报告和日志搬前搬后各跑一遍逐字比对，一样。
