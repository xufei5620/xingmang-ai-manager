## 用户

- 修复部分 Windows 电脑上从星芒打开 Codex CLI 时，窗口里报一段英文错误后直接退出、提示「AI 工具可能是意外退出了」的问题。

## 开发

- Windows 上从本软件打开 Codex（新对话与「接着聊」）时，已装版本 ≥ 0.156.0 就带 `--no-daemon`。Codex 0.157.0 把自动起后台服务（`features.daemon_auto_start`）转为默认开，后台服务要用 `CREATE_BREAKAWAY_FROM_JOB` 脱离启动它的窗口；宿主外层有不许脱离的 Job Object 时报 `host Job Object prevents daemon detachment` 退出，以管理员身份运行时同样拒绝启动。本软件的启动链（libuv 的 Job 带 `SILENT_BREAKAWAY_OK`、`Start-Process`、开机自启走 Run 键）不加这种 Job，也放不开外层的，所以改为内嵌模式。0.155.x 及更早不认这个参数、读不出版本时不带；macOS 不变。见 `tool-installation.ts` 的 `cliLaunchArgv`。
