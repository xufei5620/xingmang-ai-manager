## 开发

- 主进程几处没人 await 的后台操作补上出错处理，失败只记运行日志、不再变成进程级「未处理的 Promise」：
  画布窗口里弹窗 / 跳转转交系统浏览器（`canvas-window.ts`，记 `canvas/external.open.failed`）；
  启动更新检查超时后补下、开发环境不等下载（`updater.ts` 新增可选 `reportBackgroundError`，
  `main.ts` 接到 `updater/download.background.failed`；真正的下载失败照旧由 `download()` 发 error 快照给界面）；
  打开软件后顺手清理旧 PowerShell 启动文件（`system-service.ts`，记 `install/cli.powershell-shim.sweep-failed`）。
- `main.ts` 的 `unhandledRejection` / `uncaughtExceptionMonitor` 运行日志监听改为运行日志一建好就挂上，
  补上「启动日志已停写、运行日志监听还没挂」这段空窗（中间隔着 macOS 安装位置提示框等启动步骤）。
