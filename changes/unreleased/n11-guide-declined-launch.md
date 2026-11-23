## 用户

- 修复了新手引导最后一步点击「先不打开」后被视为已完成的问题。

## 开发

- 0.2.25 总单第 47 项（11-18 复核 N11）：引导最后一步点「打开」，主进程在「这个文件夹不建议打开」「文件夹不让写入」那两问里
  被点了「先不打开」时回 `{ declined: true }`（`electron/ipc/handlers/launch.ts`），可 `useToolLaunch.ts` 的 `openTool` 只看账号换没换，
  照样回 true，引导就清掉进度、整个关掉，客户以为走完了。现在 `openTool` 看到 `launchDeclined(result)` 回 false，
  引导停在「准备就绪」，再点一次打开了才算走完。首页、托盘那几处不看返回值，行为不变；记录页「继续对话」本来就认 declined。
- 用例：`testing/app-check.mjs` 加一条（夹具 `?launchDeclined`，头一次打开回 declined），在旧代码上红（引导被关掉、`start-guide` 找不到）。
