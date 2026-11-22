## 开发

- 0.2.25 第二轮复查第 12 条：删掉主窗口通道 `canvas:open-asset-library`。#2064 把「创作」的「看全部作品」换成作品库以后，
  新旧两套界面都不再调它。契约、preload（通道表和 `window.xingmang` 上的方法）、`ipc.ts` 的注入项、`ipc/handlers/window.ts`
  的注册、`ipc-channel-policy.ts`、`main.ts` 的接线一起删，渲染层能碰到的主进程入口少 1 个。客户看不到任何变化。
- 画布那一侧没动：`CanvasWindowController.openAssetLibrary`、`canvas-host:show-account-assets` 推送和 `?view=assets`
  是跟画布内核配对的，要删得两个仓库一起改，这次不碰；画布窗口自己的素材库照旧。
- `ipc.test.ts` 里打这条通道的那几行和夹具随之删掉，`canvas:open` 那条用例的断言不变；renderer-v2 测试夹具删掉对应的空实现。
