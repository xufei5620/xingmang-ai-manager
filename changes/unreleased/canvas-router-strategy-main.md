## 开发

- 画布主进程认内核路由节点的两种选法（桌面审查 D06，0.2.25 总单第 46 项），先不放出：`desktopCanvasCapabilities.features.routerStrategy` 仍是 `false`，运行请求里带 `routerStrategy` 的照旧在付费前按「路由策略」挡下，客户看不到变化。放出要跟 xingmang-canvas #50（旧工程的「保留全部输入」按全部输入运行）进的内核 tag 一起同步、另开 PR。
- `canvas-request-parser.ts`：`routerStrategy` 无论开没开都按内核的格式核对（版本 1，`first-available` / `all`，多一个字段就拒）；开了只留在路由节点上，别的节点带它照旧挡下。
- `canvas-node-executors.ts`：路由节点有了自己的执行器。带策略时按内核 `selectCanvasRouterInputs` 选：「保留全部输入」文字按连线顺序全部拼起来、素材按 `assetId` 去重全部交出；「每种媒体保留首个输入」取第一段不空的文字和图片、视频、音频各第一个。没有策略的老路由照旧走原来的 `passThrough`。
- `canvas-run-engine.ts`：从带策略的路由节点连出去的单图连线，按端口的类型交出（`out:image` / `out:video` / `out:audio`），「保留全部输入」交出这种类型的全部，每个按它在这条线上的位置记 `outputIndex`（角色、平铺照这个认）；文字只从 `out:text` 那条线交出，不再跟着图片线再来一遍。路由节点自己收到的文字另按连线记一份 `texts` 给执行器挑。下游指纹按实际交出的一个或全部素材算；没有策略的老路由节点和别的节点，交法和指纹都不变。
- `canvas-fingerprint.ts`：指纹加上 `routerStrategy`，只有带策略的路由节点有它，原来的节点指纹不变。
