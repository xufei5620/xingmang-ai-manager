## 用户

- 首页点「打开」，工具卡马上变成「打开中」，不用再等几秒没动静、以为没点上；这期间别的「打开」也先灰着，不会再点了没反应。

## 开发

- #1104 第 3 条：`App.tsx` 的 `launch:<工具>` 任务从点下去那一刻就挂上（新的 `holdLaunch`），读配置、核对默认模型、选文件夹、
  Codex 桌面端查运行状态和问中文都算在里面。以前要等 `prepareToolLaunch` 和选文件夹走完才挂，这几秒卡片没变化，再点又被
  `launchRequest` 静默挡掉。`toolbox.run` 同一个 key 只放一个，所以只在最外层挂一次：`requestLaunch` 和 `launch()` 各挂一次，
  里面的步骤抽成不挂任务的 `openTool()`，`launchRemembered` 也改走它。没加新字，挂的是现成的「正在打开工具」（`launchWaitLabel`）。
  准备到一半换了账号，`cancelPendingLaunchDialogs` 当场放掉这一次（`preparingLaunches`），卡片不陪旧账号那一次等完、新账号的「打开」
  也不被它的锁挡住；主进程已经开始打开的（`toolsApi.launch` 之后）照旧等它做完。记录页「接着聊」自己调 `prepareToolLaunch`，不经这里，不受影响。
