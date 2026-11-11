## 开发

- 画布完善第 7 条第三步（#1397）的六种图片工具打开：画布内核同步到 xingmang-canvas `kernel-v0.1.11`（b6c7977，xingmang-canvas #47），契约版本、工程格式版本不变。内核的 `runtime/host-run-preparations.ts` 在宿主有 `completeRunPreparation` 和 `readImageForRunPreparation` 时替宿主处理图片（收 `run-waiting` 的 `imagePreparations`，先按网页服务端的规矩核对，再按顺序读来源图、用 `library/browser-image-transform.ts` 处理，张数尺寸再核一遍，PNG 交回 `canvas-host:complete-run-preparation`；哪一步不成交不带字的失败；用了账号 LUT 调色表的图层，桌面没有 `readColorLut`，交失败）。
- 打开 `features.imageTools`，`executableNodeKinds` 加 `image-crop`、`image-collage`、`image-tile`、`image-layer`、`image-compare`、`image-panorama`（`canvas-contract.ts` 与 `canvas-preload.ts` 两份一起改）。解析器的默认值跟着开关走。内核随 `image-collage` 可用放出视频节点的「分镜」（挑几格画面，建抽帧节点和有序拼图）。
- 用户行并进 `canvas-frame-extract-on.md` 那条（这一版用户行已满 60 条，不再加新行）。Windows 冒烟的桌面节点库清单加这六种。
