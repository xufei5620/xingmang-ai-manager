## 用户

- Windows 上点「打开」「接着聊」没能打开时，错误框里只写没打开的原因，不再带着一串 XML 和一行英文命令；完整的原文记进
  反馈与诊断的日志。

## 开发

- `electron/windows-elevation.ts` 打开工具的中转脚本把 `Start-Process` 和回传进程号包进 try/catch，出错时只把 `$_` 以纯文本
  写回标准错误再 `exit 1`。以前留给 PowerShell 自己报，标准错误被重定向时它包成 CLIXML，还附上出错的那行脚本。写 `$_`
  （ErrorRecord.ToString，先取 ErrorDetails）而不是 `$_.Exception.Message`：通配符那种报错的原因只在 ErrorDetails 里。
- `describeWindowsCliLaunchError` 只从标准错误读原因，不再拼 Node 的「Command failed: 整条命令行」。`parseWindowsCliLaunchCause`：
  纯文本照用；还是 CLIXML 的（受限语言模式下 catch 里的 `[Console]` 调不了，或者脚本根本没跑，比如被杀毒拦下）解开
  `<S S="Error">`，跳过出错位置、引用的脚本和分类那几行，取第一段原因，去掉颜色转义和打头的命令名。5.1 按控制台宽度折行，
  命令出错时原因在出错位置前面、脚本没跑时在引用的脚本后面；7 带颜色转义，脚本没跑时原因在「|」后面。PowerShell 之前报过
  进度的，CLIXML 头先写出去、XML 退出时才写，catch 写的原因夹在两者之间，也认得出。超时这种读不到原因的，落到现成的「请查看
  反馈与诊断日志」；PowerShell 根本起不来（spawn 失败，execFile 照样附一个空的标准错误）照旧用 Node 的消息。
- 原文（标准错误、Node 的消息、退出码、信号、是否超时被停）放在 `WindowsCliLaunchError.launchOutput`，`system-service` 照 Linux
  那样另记一条 `terminal.failed`（同一句「… 的命令窗口没能打开」），路径按主目录脱敏。`-EncodedCommand` 后面的 base64 里有
  文件夹和用户主目录，主目录脱敏看不进去，两种写法（Node 的命令行、PowerShell 错误视图里引用的那行脚本）都抹掉。
  `SystemServiceOptions` 加测试接缝 `launchCliPowerShell`，同 `launchLinuxTerminal`。
- `e2e/windows-powershell-probes-smoke.mjs` 方括号那项改成整段跑 App 造的中转脚本，只把要起的终端换成隐藏的 cmd.exe；
  不转义时要求原因是 catch 写回来的（标准错误里没有 CLIXML 的错误视图），按 App 的说法拼出来的错误框里没有 CLIXML 和命令行。
