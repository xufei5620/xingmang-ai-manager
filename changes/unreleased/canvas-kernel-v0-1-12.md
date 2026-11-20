## 用户

- 画布路由节点可以选「每种媒体保留首个输入」（新建默认）或「保留全部输入」；旧工程里选过「保留全部输入」的，生成时会把全部参考图交给下游。
- 画布生图可以选新出的出图型号：Nano Banana、新版 Gemini 出图、豆包 seedream、Flux、通义，还有 GPT Image 2.6。

## 开发

- 画布内核同步到 xingmang-canvas kernel-v0.1.12（359b988，`scripts/sync-canvas-kernel.mjs` 按 tag 原样同步，没有本地补丁），带进三项：
  - xc #48：回到项目中心时调宿主桥 `closeProject`，桌面 #1945 的 `canvas-host:close-project` 从这一版起才有人调（Mac 验收 R3，总单第 8 项）；
  - xc #49：认出图型号属于哪一家（`runtime/image-model-family.ts`，规则照桌面 `resolveAiModelCapability`），图片分组里有的新型号能选、不再混进文字下拉，新项目默认型号不变（总单第 10 项）；
  - xc #50：旧工程存的 `settings.strategy: 'all'` 按 `{ version: 1, strategy: 'all' }` 运行，别的旧路由说明改成「旧配置：每种素材只交出一个」（桌面审查 D06，总单第 46 项）。
- 桌面放出路由策略（yoyo 11-20 在线程卡片上选「放出两种选法」）：`canvas-contract.ts` 与 `canvas-preload.ts` 两份 `features.routerStrategy` 改成 `true`。内核从这一版起给新建路由带 `{ version: 1, strategy: 'first-available' }`，文字只交第一段不空的（以前桌面路由把全部文字拼起来）；节点和检查器显示选法、说明和「执行范围」提示。
- `canvas-request-parser.ts`：`routerStrategy` 无论开没开都按内核的格式核对（版本 1，`first-available` / `all`，多一个字段就拒）；开了只留在路由节点上，别的节点带它照旧在付费前挡下。
- `canvas-node-executors.ts`：路由节点有了自己的执行器。带策略时按内核 `selectCanvasRouterInputs` 选：「保留全部输入」文字按连线顺序全部拼起来、素材按 `assetId` 去重全部交出；「每种媒体保留首个输入」取第一段不空的文字和图片、视频、音频各第一个。没有策略的老路由照旧走原来的 `passThrough`。
- `canvas-run-engine.ts`：从带策略的路由节点连出去的单图连线，按端口的类型交出（`out:image` / `out:video` / `out:audio`），「保留全部输入」交出这种类型的全部，每个按它在这条线上的位置记 `outputIndex`（角色、平铺照这个认）；文字只从 `out:text` 那条线交出，不再跟着图片线再来一遍。路由节点自己收到的文字另按连线记一份 `texts` 给执行器挑。下游指纹按实际交出的一个或全部素材算；没有策略的老路由节点和别的节点，交法和指纹都不变。旧工程「保留全部输入」下游的节点因为收到的图变了，第一次运行会重新生成。
- `canvas-fingerprint.ts`：指纹加上 `routerStrategy`，只有带策略的路由节点有它，原来的节点指纹不变。
