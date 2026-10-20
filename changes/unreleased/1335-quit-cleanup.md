## 开发

- #1335 第 3 条：退出那一拍（will-quit）写的运行日志改成当场同步写。以前排进异步队列，will-quit 一返回进程就退了，「应用主进程即将退出」（`app.stopping`）和退出清理哪一步失败了（`app.quit-cleanup.failed`）多半落不了盘。用 Electron 43 在 Linux 上实测：改之前退出 6 次丢了 4 次，改之后 8 次都在。`RuntimeLogStore.writeSynchronouslyFromNowOn()` 由 `main.ts` 的 will-quit 在跑清理之前调；同步写走同一套 `safe-local-data` 检查和轮转（`appendSafeUtf8FileSync`、`removeSafeDataFileSync`）。队列里还有没跑完的追加或读取时照旧排在后面，不跟进行中的那次抢同一个文件位置，先后也不乱。没有拦下退出再 `app.exit()`：那会跳过 `quit` 事件，退出时装更新挂在那上面。
- #1335 第 1 条：`main.test.ts` 给退出清理的 18 步各钉一份它要跑的语句，步骤里删一句（比如 `relayRouteController.dispose()`、`clearInterval(routeOnlineTimer)`、`lifecycle.dispose()`）会红。
- #1335 第 2 条：「只许 main.ts 登记退出清理」认单引号、双引号、反引号三种写法；新加一条：`bootstrap/` 里挂的 `setInterval` 和 `app` / `powerMonitor` / `process` / `screen` / `nativeTheme` 的监听，取消句柄要 `return` 回 main.ts、并在退出清理里撤掉，不然要在测试里点名放行。
- #1335 第 12 条（一部分）：`bootstrap/lifecycle.ts` 文件头和 `main.test.ts` 加速那条的注释照实说：加速服务断开和放掉独立加速进程是按先后发出去、不互相等。
