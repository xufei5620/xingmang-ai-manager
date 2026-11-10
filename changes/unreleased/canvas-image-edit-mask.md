## 开发

- 画布完善第 5 条（桌面那半）：主进程能跑蒙版局部修改了。画布运行图里改图节点（`image-edit`）带的 `imageEditMask` 原来一律标成「桌面版暂不支持」，现在按内核同一套上限解析（`canvas-image-mask.ts`：最长边 4096、最多 128 笔、4096 个点、64 KB，未知字段一律拒），只许出现在改图节点上，原样交给执行器。
- 执行器发之前再核一遍：型号只许 `gpt-image-1` / `gpt-image-2` / `gpt-image-2-2026-04-21`（跟内核 `imageEditMaskModelSupported` 一样），原图只能一张、必须是蒙版绑定的那张，尺寸对得上，至少有一笔画笔。`ai-image-service.ts` 的改图请求读出原图字节后按实际像素再比一次尺寸，然后把笔画按内核同一套几何画成 8 位 RGBA PNG（涂过的地方全透明，其余不透明，一行一行压，4096×4096 也不整张放内存），作为 `mask` 字段随 `/v1/images/edits` 发出；做成的蒙版图到 4 MB 就不发。这些检查都在发请求之前，过不了不扣钱。
- 节点指纹和运行图版本把蒙版算进去；没有蒙版的节点指纹和以前一字不差（测试钉了 main 4049a622 算出来的值），老缓存照用。`canvas-image-mask.test.ts` 拿同步进来的内核 `image-edit-mask.ts` 对拍：65 组蒙版画出来的像素逐位相同，同一批坏输入两边报一样的字。
- 不加通道：蒙版跟着已有的 `canvas-host:start-run` 走。`desktopCanvasCapabilities.features.imageEditMask` 这次还关着，等内核把桌面点了必报错的「另存为图片」收起来（xingmang-canvas 那边的 PR）、同步进来时再打开，那时写「用户」那条。
