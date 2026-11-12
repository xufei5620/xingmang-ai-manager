## 开发

- 从星芒打开工具的窗口不再强制上色：去掉 `FORCE_COLOR=3`、`CLICOLOR_FORCE=1`，只留说明终端能显示颜色的
  `TERM`、`COLORTERM`（`CLICOLOR=1` 也留着，它只在输出给屏幕时上色）。这两项的意思是「接到管道里也照样上色」，
  AI 让子进程跑的测试、构建、`ls` 读回去的输出里都夹着颜色控制码，多花 token，靠解析输出的脚本也会出错；
  工具自己的界面接的是真终端，不靠它们也上色。Windows（`interactiveTerminalEnvironment` 和
  `windows-elevation.ts` 的窗口脚本，脚本里改成 `Remove-Item` 这两项）、Linux（`linux-terminal.ts`：
  不再 export，并进 `clearedWhenAbsentKeys`，命令窗口程序自己环境里的也不带进来）都改了；Mac 打开工具本来
  不经过这一层，`macos-platform.ts` 只是不再把继承来的这两项写进启动脚本，客户 `~/.zshrc` 里自己设的照旧
  （D74，深查 Shell差异 SH-8）。
