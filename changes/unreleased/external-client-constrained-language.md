## 开发

- Claude Desktop、OpenCode、WorkBuddy 的开机盘点脚本（`external-client-runtime.ts` 的
  `windowsExternalClientInventoryScript`）在 PowerShell 受限语言模式下也能跑完。以前第一行
  `[System.Diagnostics.Stopwatch]::StartNew()` 被拒，接着读「记住的签名」那句
  （`[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(...))`）被拒，在
  `$ErrorActionPreference = 'Stop'` 下整条退出码 1、stdout 为空，三张卡次次「命令执行失败（退出码 1）：
  powershell.exe」（2026-11-10 客户电脑）。现在计时用 `[datetime]::UtcNow`；结果用 `[ordered]@{}` 和数组，
  不再用 `[pscustomobject]` 和泛型 List；记住的签名改成「ASCII 以外的字符先写成 `\uXXXX` 的 JSON」再 base64
  （新函数 `encodeKnownExternalClientSignatures`；整条命令行比原来长约一成，带两条记住的签名时约 25700 字，
  离 32767 上限还远），脚本用字符串方法和位运算自己解；
  文件名用 `-split` 取；开头设 UTF-8 那句和最后输出 JSON 用 `powershell-constrained-language.ts`。
  要 .NET 的两处在 FullLanguage 下照旧：路径规范化在受限模式下改成凡是 `GetFullPath` 可能改写的一律拒
  （`/`、连着或结尾的 `\`、`.` / `..` 段、以点或空格结尾的段、8.3 短名、260 字及以上）；坏键逐值重读在受限模式下
  改用 `$key.Property` 加 `Get-ItemPropertyValue`。没放宽任何校验。Windows CI 上用 `__PSLockdownPolicy=4`
  强制受限模式实测过，PowerShell 冒烟检查新增一条在受限模式下用真注册表项和真文件跑盘点。
