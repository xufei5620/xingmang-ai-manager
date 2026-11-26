## 开发

- 重启框（Node.js 装完、页顶和首页「需要重启电脑」、Codex 桌面端打不开）点「立即重启」以前只看没保存完的设置和安装队列，
  「创作」里正在回复的对话、正在合成的视频、画布正在出的图都不看，一重启就断了（0.2.25 复查第 11 条）。现在新界面带
  `askIfWorking` 调 `runtime:restart-windows`，主进程先照重启装更新那一问（D10）点名问一句：同一个
  `buildUnfinishedRestartWorkPrompt`、同一份忙闲（`runningRestartWork`）、同一个原生确认框，字一个没加。
  点「等待完成」回 `{ postponed: true }`，重启框原样留着，做完再点；安装队列里还有事时不问，交给原来那道闸拦下
  （`quit-blocking-tasks.ts` 的 `confirmWindowsRestartWork`）。旧回滚界面不带参数，照旧直接重启。没加 IPC 通道，
  只给这条通道加了可选参数和返回值。
