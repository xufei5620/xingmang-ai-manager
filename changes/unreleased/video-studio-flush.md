## 用户

- 视频剪辑：点「生成」后软件马上被强行关掉，重开时照样接回已经付了钱的那几段，不再显示「还没生成」让人再付一次。

## 开发

- 视频剪辑点「生成」后几秒内强退或断电丢请求号（0.2.24 深查 KR-4）：`video:generate` 交给服务端之前先 `flushStorageData()`，让页面刚写进 `localStorage` 的请求号落盘（`electron/ipc/handlers/ai-video.ts` 的 `flushPageStorage`，拿不到会话照旧提交）；主进程意外退出那条路（`main.ts`）也补一步。落盘是交给系统写，强退、崩溃稳了；断电时系统缓存里没写下去的那一点仍可能丢（leveldb 不逐条 fsync），要靠 DM-8。不加通道、不改字。`ipc.test.ts` 钉住落盘在提交之前。分镜整份搬进主进程（DM-8）以后再根治。
