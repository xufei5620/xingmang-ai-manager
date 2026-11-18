## 开发

- 并发竞态 BF3：`useToolInstall.tsx` 的 `prepareRuntimeForInstall` 抢不到 node 那把锁时直接抛「运行环境正在准备」，外面再包成「Node.js 运行环境没装上，X 还没开始安装」。改成 `runtime-readiness.ts` 的 `prepareSharedRuntime`：抢不到就再要一次 `prepareRuntime`，主进程 `runtime:node` 同一个键复用同一次安装，不会装两遍。`StartGuide.tsx` 认那句旧报错的分支随之删掉。浏览器夹具的 `installNodeRuntime` 照主进程队列合并并发调用，`app-check.mjs` 加一条回归。
