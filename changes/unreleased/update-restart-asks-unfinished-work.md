## 开发

- 0.2.24 深查改字批次 P04（D10 ＋ D9，并发竞态.md BF1、界面和功能页.md S1；W1 作废）：`confirmUpdateInstall` 改走
  `quit-blocking-tasks.ts` 的 `confirmUpdateRestart`，先问工具在装（已知31，原样），再按 `buildUnfinishedRestartWorkPrompt` 问聊天、视频剪辑拼片、画布出图。
  更新页「重启并安装」、状态栏版本号、强制更新那层、托盘「重启并安装」和跳框里的「现在安装」都经过它；点「等它做完」回 `postponed`，跟「继续安装」一样这次不装。
- 界面这边只报正在做的那几样，不拿 `rendererBusy`：从更新页点的时候那个确认框自己就开着。`RendererActivity` 加可选的 `work`（`'chat' | 'video-compose'`），
  不加通道；`parseRendererActivity` 只认这两样、条数不超过种类数。`useBackgroundWork` 多一个可选参数标这一样，`renderer-release.ts` 记下最近一次报的、界面关掉时清空。
- 画布那一样由主进程自己看：`AiImageService.hasPendingWork()`（队列里还有图没收完，含停止以后接着收的）和 `canvasRuns.hasActiveRuns()`。
  交给服务端的视频（视频剪辑出片、画布出视频）不算，重开以后会接着取回来。
- 更新确认框那句换成 D9：「请先保存当前工作。星芒会先关掉，装好自动重新打开。」
