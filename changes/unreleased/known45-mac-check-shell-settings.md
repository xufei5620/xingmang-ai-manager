## 用户

- Mac 上检查页「电脑里另外设过的工具地址或密钥」这一项，现在也会看终端设置（`~/.zshrc` 这类文件）。里面另外设了会让
  Claude Code、Gemini CLI 不用当前账号的 Key、地址或配置文件夹的，会写出是哪几项、在哪个文件里，只写名字、不写值。
  从星芒打开的工具不受这几项影响，所以标「需留意」，开机时不会为它提醒。只看在用星芒账号的工具。
- Mac 上从终端里打开星芒、星芒自己就带着这几项时，以前这一项标「待处理」；从星芒打开的工具已经不受它们影响的，现在同样标「需留意」。

## 开发

- 已知45 检查页那半（yoyo 10-6 回「改」，用的是 11:16 给的三处新字）：`diagnostics.ts` 的
  `PROVIDER_ENVIRONMENT_OVERRIDE` 在 Mac 上另去读 9 个终端设置文件（`~/.zshrc`、`~/.zprofile`、`~/.zshenv`、`~/.zlogin`、
  `~/.bash_profile`、`~/.bash_login`、`~/.profile`、`~/.bashrc`、`~/.config/fish/config.fish`），经 `readSafeUtf8File`
  读，上限 512 KiB；链接、硬链接、超大的不读，原因只进日志（`diagnostics.shell-settings.skipped`），I8 不放宽。
  只找 `breaksAccount` 的四个，只看用星芒账号（`relay`）的工具：Claude Code 用自己账号时启动脚本不去掉它们（#920），
  报了「从星芒打开不受影响」就不对；Gemini CLI 不用星芒账号时这几个起什么作用没实测过（T12）。空值、指向当前账号的地址、
  指向 `~/.claude` 的 `CLAUDE_CONFIG_DIR` 不报，看不出值的照报；同一个名字在一个文件里导出几次，有一次指向别处就报。
- 新模块 `shell-startup-exports.ts`：纯函数 `parseShellStartupExports(text, dialect, names, home)`，按 zsh、bash 与 fish 的
  引号、转义、注释、here-document、`;`、`&&`、换行分句，认 `export`、`typeset -x`、`declare -x`、先赋值后 `export`、
  `set -a` / `setopt allexport`，以及 fish 的 `set -x`（各种写法）和它的 `export` 函数。`$HOME`、`${HOME}`、不带引号的
  开头 `~` 换成主目录，别的展开一律当看不出值。不执行、不跟 `source`。`unset`、`set -e` 不抵消前面的导出：在函数里
  切换中转的写法常见，从上往下读是「已删」，客户终端里却可能还留着。
- 结论：都是启动脚本会去掉的（`droppedByMacosLauncher`，和 `system-service.ts` 的 `macosShellOverrideVariables` 对齐，
  单测逐个变量、逐种账号钉住）→「需留意」，新字「终端设置里另外设了 {名字}：从星芒打开的工具不受影响，自己开终端直接用
  {工具} 时会不用当前账号的设置。用不着的话，把这几项从终端设置里删掉」，详情行「{名字}（{工具}，在 {文件}）」。名字超过
  三个沿用「等 N 项」，同名只说一次（`namesOf` 去重）。启动脚本照旧会带过去的（Claude Code 没用星芒账号时，星芒进程环境里的）
  仍是原来的「待处理」，原话不变，只点这几个的名。星芒进程环境里和终端设置文件里同名的，只留带文件的那条。
  Windows、Linux 的输出一字不变。
- 单测：解析 25 条（含 fish 6 条）；检查页 Mac 14 条，含真建链接的 `~/.zshrc` 不读、日志里没有值和主目录，Windows、Linux
  不读这些文件。另在沙箱里拿真 zsh 5.9、bash 5.2、fish 3.7 对了 47 段写法（没进仓库），只有两处 zsh 才有的边角
  （`~不存在的用户/…`、`~"/…"`）多报，都是多报不漏报。故意改坏 32 处，每处都有单测红。没在真 Mac 上演过。
