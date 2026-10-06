## 用户

- Mac 上「终端」用的是 bash 或 fish 的（比如早年建的老账号），自己新开的「终端」里现在也能直接敲 claude、codex、gemini、grok
  启动了，以前会提示找不到命令。以前装过的，升级后打开一次星芒就会补上。

## 开发

- 第三十四批 C：`electron/macos-shell-profile.ts` 按账号的登录 shell 选文件（`planMacosShellProfileTarget`）。zsh 照旧
  `~/.zprofile`；bash 追加到 `~/.bash_profile`、`~/.bash_login`、`~/.profile` 里第一个存在的那个（bash 登录 shell 只读它），
  三个都没有才新建 `~/.profile`，从不建 `~/.bash_profile`。「存在」照 bash 自己的判法：失效的链接跳过，活的链接、文件夹、
  读不了的文件都算，于是被拒绝，不退到一个 bash 根本不读的 `~/.profile`。fish 写自己的 `conf.d/xingmang-ai-manager.fish`
  （认 `XDG_CONFIG_HOME`），不改 `config.fish`，同名文件不是我们写的就不动。三种用同一对标记、同样三个目录接在 PATH 最后。
- 其余照 zsh 那一套：只追加不重写、已有标记就不动、符号链接或多链接的文件拒绝并只记日志（I8）、打开软件只补一次
  （`terminal-commands-added`）。以前 bash、fish 账号在判断 shell 那一步就返回、没留记录，升级后第一次打开软件就会补上。
  `isZshLoginShell` 换成 `resolveMacosLoginShell`。
- 日志：`cli.shell-profile.checked` 在登录 shell 不是 zsh、bash、fish 时改说「登录 shell 不是 zsh、bash、fish，没改终端
  启动设置」，以前也落进「终端启动设置无需改动」；出错时的说明带上是哪个文件（如「终端启动设置（~/.bash_profile）」）。
- 测试：`macos-shell-profile.test.ts` 补 bash 三种文件情况、失效链接、fish（含 `XDG_CONFIG_HOME`、同名文件）、tcsh、
  符号链接和硬链接，另有真 zsh、bash（三种文件情况和失效链接）、fish 登录 shell 里按名字找到命令的端到端用例（系统自带的
  或 Homebrew 装的，有哪个跑哪个；CI 的 Mac 上有 zsh 和 bash）；`windows-cli-shell-access.test.ts` 补四种结果各自的日志。
