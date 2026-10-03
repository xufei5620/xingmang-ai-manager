## 用户

- 打开软件时，首页一摆出上次的工具列表就能点「打开」和「接着聊」，不用再等本机检测跑完；还没装的工具，「安装」照旧等检测完再点。

## 开发

- 第三十一批 A，收回 #403 的「检测完才给点」。#403 让按钮等检测没有安全上的理由，只是沿用了 loading 的语义：
  点「打开」时渲染层现读配置（`App.tsx` 的 `launch`），主进程 `launchProviderOperation` 现读配置、现找工具（`inspectCliTool`）、现查目录，用不上上次的检测结果。
  `Home.tsx` 的 `launchReadyBeforeScan` 只在 `cachedAt` 那段放开已装、已连好、配置读到了、这一行没有任务在跑的「打开」，「接着聊」跟着同一行走；
  「安装」「重新检测」「重新配置」「连接账号」照旧等检测跑完。
- 会拿旧 Key 打开的只有一种情形：开机账号同步要给已连好的工具换 Key（Key 换了分组），而写入要等那一轮检测跑完。
  `bootstrapAccountTools` 在恢复这一档问完服务端后把这几家放进进度的 `connectedKeyChanges`，`accountKeyChangePending` 据此只让它们照旧等；
  登录还在恢复、同步还没开始或还没回话、登录与点名重写两档（会重写已连好的工具）一律算说不准，照旧等检测跑完。
- 检测没跑完就打开时，那一轮落地带的是打开前读的配置，会把刚记下的文件夹（`rememberedWorkspace`）盖回去：
  这种情况下 `App.tsx` 打开后重读一次配置，走 `useToolbox` 的 `configRevision`，落地时用新的。
- 浏览器夹具 `?cachedScan` 改成开机那一轮谁来要真结果都接同一轮（同主进程 `coalescedScan`），新增 `?regrouped=`；
  `app-check.mjs` 加五条，`Home.test.tsx`、`account-bootstrap.test.ts` 补单测。
