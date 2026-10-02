## 开发

- Linux 版拆分 ④（摸底 G5）：客户自己开的终端里能直接敲 claude / codex / gemini / grok。新模块
  `electron/linux-shell-profile.ts`：星芒装进托管 npm 前缀的每个工具在 `Cli/launchers` 下有一个小启动器，
  只对这一条命令把星芒准备的 Node.js 排到最前再 `exec` 真正的入口，系统自带的旧 `node` 截不走
  `#!/usr/bin/env node`，用户自己敲的 `node` 不变；入口不见了就用中文说去星芒里重装。Grok 在 Linux 上由 xAI 的
  postinstall 装在 `~/.grok/bin`（拆分 ③），只在 `grok` 是指向旁边 `grok-<版本>` 的相对链接（npm 布局）时配启动器，
  启动器直接转到这个链接、不动 PATH，更新改指向后不用重写；xAI 官方安装器那种布局不配。
- 终端启动文件：`~/.bashrc`、`~/.zshrc`、`~/.profile` 末尾追加和 macOS 同一对标记的几行，只把启动器目录接在
  PATH 最后；fish 写自己的 `conf.d/xingmang-ai-manager.fish`，不改 `config.fish`。只给已存在的文件和账号登录
  shell 自己读的文件加，从不建 `~/.bash_profile`；符号链接、硬链接的文件跳过并记日志（I8）。打开软件只补一次
  （`terminal-commands-added`），装、修、更新时再确认。在星芒里卸掉它装的最后一个工具时逐字去掉这几行（保留文件
  权限和用户在前后加的内容，用户改过的那段不动）、删 fish 文件和启动器目录；打开软件时从不撤。
- `createCliTerminalAccess` 加 Linux 分支（`syncTerminalCommands`，同一时间只跑一次；打开软件时有星芒装的工具或装了 Grok
  才同步一次）和 `release`，卸载成功后调用；
  Windows、macOS 的走法不变，测试钉住两边都不会用到 Linux 那条。`linuxCommandPathCandidates` 把继承 PATH 里的
  启动器目录剔掉，软件扫描不会把启动器当成一份安装。`managed-cli-paths.ts` 新增 `managedTerminalLauncherDirectory`；
  `writeAtomicSafeUtf8File` 可选 `mode`（缺省仍是 0600）。
- 测试：`linux-shell-profile.test.ts`（含真 bash 交互 / 登录 shell 里 `command -v` 与旧 node 不抢的端到端用例，
  有 zsh、fish 时也跑）、`windows-cli-shell-access`、`linux-platform`、`safe-local-data`、`system-service`（Linux
  托管安装后与卸载后各同步一次）。
- 文档：`docs/LINUX.md` 第 1 节加「终端里直接敲命令」、第 5 节把 ④ 标为已做；`docs/MODULE-MAP.md`、
  `.claude/rules/linux-platform.md` 补一行。
