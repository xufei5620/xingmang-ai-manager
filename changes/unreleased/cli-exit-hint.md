## 用户

- AI 工具在终端里退出后，窗口里会多两行中文，告诉你接下来怎么做：想接着聊就回星芒点「接着聊」，窗口可以直接关；如果看起来是意外退出，会提醒你回星芒点「检查」看看。Windows 和 Mac 都有。

## 开发

- 第十二批候选 10：`electron/windows-elevation.ts` 的 `buildCliLaunchPlan` 在 `& <工具>` 后按 `$LASTEXITCODE` 输出两行固定提示（非零或启动失败走「可能是意外退出」），`-NoExit` 保留；`electron/macos-platform.ts` 的 `buildMacosTerminalScript` 去掉 `exec`，用 `|| cli_exit_code=$?` 接住 `set -e` 下的非零退出，并加 `trap ':' INT` 让 zsh 在 Ctrl+C 时不随工具一起被打断（处理器不是忽略，子进程仍是默认 SIGINT）。文案收在新模块 `electron/cli-exit-hint.ts`，两侧共用；只加固定字符串，未引入新输入（I1、I14）。
