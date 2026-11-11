## 开发

- 检查页「电脑里另外设过的工具地址或密钥」在 Windows、Linux 上也读客户自己开终端时会读的设置文件（深查 Shell差异 SH-5）：
  Windows 读个人文件夹下 Git Bash 的 `.bashrc`、`.bash_profile`、`.bash_login`、`.profile`，和「文档」（宿主给的实际位置，
  OneDrive 挪走的也对）下 `PowerShell\`、`WindowsPowerShell\` 里的 `Microsoft.PowerShell_profile.ps1`、`profile.ps1`；
  Linux 读和 Mac 同一批 bash、zsh、fish 文件，`~/.bashrc` 排第一。PowerShell 启动文件由新的
  `powershell-profile-exports.ts` 认 `$env:NAME = …`、`[Environment]::SetEnvironmentVariable(…)`、`Set-Item`/`New-Item Env:…`
  三种写法，带 BOM 的 UTF-16（Windows PowerShell 5.1 的 `>` 存出来的）照样读。只在文件里找到的报「需留意」，句子和 Mac
  同一句；进程环境里的照旧「待处理」，两条各报各的；「删掉这几项设置」只挂在「待处理」上（它删不到文件里）。
- Mac、Linux 的检查页另读 fish 的 `conf.d/*.fish` 和 `set -Ux` 存进的 `fish_variables`（只算带 `--export` 的，SH-12 d）。
- Mac 点「打开」后等启动脚本真跑起来（最多 20 秒，脚本第一行删掉自己，同 Linux，SH-3）：「终端」开了窗口、脚本却被
  oh-my-zsh 的更新提问吃掉或被 `.zshrc` 里的 `exec tmux` 顶掉时，不再当成打开成功，报「终端窗口打开了，但工具没有跟着起来……」
  （yoyo 定的字）、另记一条 `terminal.failed`，没跑的脚本当场删掉，免得窗口迟到时又把工具开起来。
- Mac 的启动脚本只检查真要写进脚本的那几个变量（SH-11），同 Linux：名单外带 `BASH_FUNC_x%%` 这类怪名字时不再整次打不开。
- 以管理员身份运行时，推 Windows 版 Grok 拿哪个 shell 跑钩子照它那个窗口收窄过的 PATH 推（`grokShellEnvironment`，SH-10）：
  pwsh 只装在用户目录（商店版、scoop）时不再按 PowerShell 写钩子、让 Grok 用 Git Bash 跑出一行行红字。
- Mac 上登录 shell 是 zsh、bash，而 fish 的设置文件夹在的，顺带给 fish 也放一份 `conf.d/xingmang-ai-manager.fish`，同 Linux
  （SH-12 b）；写不进去只记一笔，不影响主的那份。写进 `.zprofile` 那句注释不再列 gemini（SH-12 c）。
- `windows-cli-shell-access.ts` 记下删 `.ps1` 改走 `.cmd` 的代价（参数被 cmd 再解析一遍，SH-9），不改行为。
