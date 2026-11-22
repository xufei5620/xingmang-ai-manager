## 开发

- 卡住时上报卡在哪段代码（0.2.24「卡住」比 0.2.23 多出十倍但只有次数，yoyo 11-20「卡顿做」）。主进程：匿名统计的卡住计时器这次打开第一次报卡住 2 秒以上后才起后台线程（`main-hang-watchdog-worker.ts`，约 10 MB），窗口在前台时每秒一次心跳，5 秒没心跳就用进程内调试会话（`Session.connectToMainThread`，不开端口）让主线程停一下、抄下调用栈立刻放行，抓一次就关线程。界面：窗口「没响应」时用 `collectJavaScriptCallStack` 问卡在哪（新开 `--enable-features=DocumentPolicyIncludeJSCallStacksInCrashReports`，主窗口协议回包加 `Document-Policy: include-js-call-stacks-in-crash-reports`），最多等 3 秒。两种都按崩溃上报那套打码、改写帧地址后发 Sentry，级别 `warning`、mechanism `main-hang` / `renderer-hang`；跟着「自动发送错误报告」开关，关了不起线程、不问；只在抽中的两成打开里报，一次打开各最多一回，护住 Sentry 免费版每月 5000 条的额度。
