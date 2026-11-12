## 开发

- 改当前用户 PATH（装好命令行工具后把目录加进去、卸载时拿掉）、检查页读和清旧的代理环境变量、一键删掉
  覆盖设置，这五段 PowerShell 在受限语言模式下也能跑完（用户那条并进 `codex-desktop-constrained-language.md`）。
  以前它们开头设 UTF-8 输出那句写在 `$ErrorActionPreference = "Stop"` 后面，受限模式一拒就整条结束；后面又全靠
  `[Environment]::`、`[IO.Path]::` 和注册表键的 .NET 方法，同样被拒。现在第一行之后先接一段只有非 FullLanguage
  会话才走的分支（`buildPowerShellConstrainedLanguageBranch`），用 `Get-ItemProperty` / `New-ItemProperty` /
  `Remove-ItemProperty` 读写 `HKCU:\Environment`：PATH 原样读（暂时拿掉进程环境变量，Windows 就不展开
  `%NAME%`，`finally` 里放回），类型用 System32 的 `reg.exe` 查、照原类型写回，写完用 System32 的 `setx.exe`
  广播一次、再删掉它留下的空值。FullLanguage 走的那几行一字没动；只写当前用户，不碰机器级设置和执行策略，
  名字照旧过固定名单。Windows CI 上用 `__PSLockdownPolicy=4` 强制锁定实测过改前改后两轮（14 种情况，注册表
  结果与 FullLanguage 逐项相同，有写入的都广播到了），PowerShell 冒烟检查新增一条把两种模式各跑一遍、对照注册表；新单测
  `powershell-constrained-language-environment-scripts.test.ts` 钉住分支里不用受限模式拒绝的写法。
