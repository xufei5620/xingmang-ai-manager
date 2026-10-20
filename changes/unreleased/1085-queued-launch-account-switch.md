## 开发

- #1085：`cli:launch` / `desktop:launch-codex` 不再在 IPC 层整段套 `accountWork.run`，改由处理函数拿 `accountWork.queue()` 交给安装队列：点下去时照旧核对账号没在切换，排队那段不算进 `whenIdle`，轮到它执行时才 `run`；排队期间换过账号就不执行（报现成的「账号上下文已变化，请重试」）。`main.ts` 的 quiesce 一开始调 `abortQueued()`，还在排队的打开经 `InstallationQueue` 的 signal 出队。开机照旧先等账号恢复完。
- 首页 `launchBusy` 只认命令行工具和 Codex 桌面端的打开；外接客户端那一行只看自己那家的打开（主进程里它们本来就不互等，I11 的登记例外）。
