## 开发

- 手机遥控（M16，11-18 手机遥控专项）：手机遥控页第一次读状态走 `useResource`，读回来直接整份放上去，不跟手上的比版本号；
  读的时候主进程先推来一份更新的（比如刚连上、Codex 启动失败的黄条），读回来的旧快照会把页面退回去，同一时刻状态栏
  （`useCodexRemoteActive` 比了版本号）却是新的。现在页面收到的每一份（事件、操作返回、第一次读取）都先过
  `createRemoteSnapshotKeeper`，第一次读取交给页面的是至今最新的那份。`src/renderer-v2/features/settings/codex-remote/`，
  不加新字，版面不变。
