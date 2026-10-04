## 用户

- Windows 上项目放在名字带英文方括号的文件夹里（比如「作业[1]」「[2024]课程资料」），以前点「打开」或「接着聊」每次都打不开，
  现在能正常打开。打开失败时，中文 Windows 上的错误说明也不再是乱码。

## 开发

- 第三十五批 A：`electron/windows-elevation.ts` 打开工具的中转脚本用 `Start-Process -WorkingDirectory` 起终端，这个参数没有
  -LiteralPath 写法，PowerShell 一律按通配符解析（`PathUtils.ResolveFilePath` 不带 isLiteralPath），文件夹名带 `[` `]` 时报
  「the wildcard path … did not resolve to a file」，旁边碰巧有对得上的文件夹（`作业1`）才打得开。新增 `escapePowerShellWildcard`，
  在 TypeScript 里给 `` ` `` `[` `]` `*` `?` 各加一个反引号（与 PowerShell 7 的 `[WildcardPattern]::Escape` 同一组字符；6.0 的不转义
  反引号，所以不在脚本里调它），再照旧包 `powerShellLiteral`。只用在 `-WorkingDirectory`；终端里的 `Set-Location -LiteralPath` 和
  `execFile` 的 `cwd` 照原样。
- 中转脚本开头补上 UTF-8 输出（`[Console]::OutputEncoding`，try/catch 包住，设不上照旧往下走）。`-EncodedCommand` 起、标准错误被
  重定向时，PowerShell 把报错写到 `Console.Error`，编码跟着 `[Console]::OutputEncoding`；中文 Windows 默认 GBK，`launchCliPowerShell`
  按 UTF-8 读回是乱码，`describeWindowsCliLaunchError` 里按中文认原因的几条也认不上。终端窗口那段早就有这句，中转脚本漏了。
- `e2e/windows-powershell-probes-smoke.mjs` 加一项：按 App 给 `作业[1]\a`[b]` 造的中转脚本，执行到 `Start-Process` 为止都照原样，
  只把要起的终端换成隐藏、等它结束的 cmd.exe，确认能起、而且起在这个文件夹里；不转义的同一脚本必须仍然失败，报错里的中文按 UTF-8
  读得出来。Windows PowerShell 5.1 和 PowerShell 7 都跑。单测按 PowerShell 的 `WildcardPattern` 规则核对转义后读回来是原路径。
