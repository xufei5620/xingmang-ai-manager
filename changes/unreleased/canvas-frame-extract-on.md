## 开发

- 画布完善第 7 条第二步（#1397）收尾：画布内核同步到 xingmang-canvas `kernel-v0.1.9`（4b82a00，xingmang-canvas #46），契约版本、工程格式版本不变。内核的 `runtime/host-run-preparations.ts` 在宿主同时有 `completeRunPreparation` 和 `readVideoForFramePreview` 时替宿主抽帧（收 `run-waiting` 的 `framePreparations`，读视频、解帧，PNG 交回 `canvas-host:complete-run-preparation`；读不出、解不出交不带字的失败；宿主不再列、运行结束、换项目时停下不交）。
- 打开 `features.frameExtract`，`executableNodeKinds` 加 `frame-extract`（`canvas-contract.ts` 与 `canvas-preload.ts` 两份一起改）。解析器的默认值跟着开关走，抽帧节点不再被拒；别的节点带抽帧时间照旧拒。内核按 `getAssetDetail` + `readVideoForFramePreview` + `frame-extract` 可用放出视频选帧；分镜拼图要 `image-collage`，桌面没有，照旧藏着。
- 用户行跟 `canvas-get-asset-detail.md` 那条并成一条，那份只留「开发」。
