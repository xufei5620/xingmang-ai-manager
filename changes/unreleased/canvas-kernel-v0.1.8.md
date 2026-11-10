## 用户

- 画布能圈一块局部重画了：在结果图上点「局部修改」，涂出想改的地方，建好局部修改节点后写一句要怎么改再运行，模型主要改涂过的那块。局部修改目前用 GPT Image 2，选别的型号会提示换。

## 开发

- 画布内核同步到 xingmang-canvas `kernel-v0.1.8`（f9a4ed7，xingmang-canvas #44），契约版本、工程格式版本不变。#44：宿主没声明 `byteUpload` 时，蒙版编辑器不给「另存为关联图片节点 / 独立图片节点 / 保存至当前节点」和「图片保存方式」（新入口 `maskAssetSave`），说明只讲 AI 局部修改。桌面那条 `importAssetFile` 只收用户拖进来的磁盘文件，原来点了只会报「上传结果尚未确认」。
- 打开 `desktopCanvasCapabilities.features.imageEditMask`（`canvas-contract.ts` 和 `canvas-preload.ts` 两份一起改，`canvas-contract.test.ts` 钉住）。主进程那半是 #1714（`canvas-image-edit-mask.md`）：改图节点的蒙版按内核同一套上限解析，发之前核对型号和原图，画成透明 PNG 随 `/v1/images/edits` 发出。
