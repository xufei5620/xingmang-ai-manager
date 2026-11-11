## 开发

- 画布完善第 7 条第三步（#1397）第 3 个 PR：桌面接上宫格裁剪（`image-grid-split`），一个节点出「行 × 列」张图。主进程照旧不解读参数，只从里面读行数、列数（各 1 到 4）核对交回的张数，不核尺寸；执行器要求恰好一张来源图。每张切片记第几格（`CanvasRunCandidate.outputIndex`），整组存进缓存（`CanvasRunCacheEntry.candidates`，第一项就是原来的 `candidate`，老版本只读它；有一张切片没了整条缓存作废）。
- 往下传照网页版：单根连线传节点上选中的那一格（`imageOutputIndex`，解析器核 0 到 15、超出格数退回第 0 格；不进节点指纹，只进工作流版本，换一格不重新切），有采用的先用采用的；`out:images` 批量口按格子顺序传全部切片，批量连线的指纹带上整组切片。其余节点（候选画廊、路由）的取图顺序不变。
- `canvasRunKernelOnlyNodeLabels` 现在是空的；契约样例和运行服务测试里「桌面不支持」那条改用生视频的「生成音频」设置。`executableNodeKinds` 加 `image-grid-split`，Windows 冒烟的桌面节点库清单加「宫格裁剪」。
