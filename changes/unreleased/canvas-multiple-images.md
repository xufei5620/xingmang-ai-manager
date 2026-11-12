## 用户

- 画布的图片生成、改图节点可以一次出 2～4 张挑着用：在「生成数量」里选 ×2～×4，就按张数各发一次生成，每张单独扣一次费。
  一张没出来不影响另外几张，出来的都留在节点上；选好一张后，接在后面的节点用的就是这一张。
  生图型号的下拉也加上 GPT Image 2.5 Flare 和 GPT Image 2.5 Sunburst，账号分组里有就能选；新项目在分组有 Flare 时默认用它，已有项目选好的型号不变。

## 开发

- 画布一次出多张（画布完善第 4 条，#1396 多候选那一项）：解析器对 `image` / `image-generate` / `image-edit` 不再把 `imageCandidateCount` 2～4 当成桌面不支持，而是放进运行图（`CanvasRunGraphNode.data.imageCandidateCount`，1 不放，跟以前一样）；别的节点带这个字段照旧拒。`desktopCanvasCapabilities` 和画布 preload 的 `imageCandidates.maximum` 从 1 改成 4。
- 运行引擎（`canvas-run-engine.ts`）对多张节点走 `runImageBatch`：每张一次独立请求、各自的 attemptId（所以请求号也各不相同），上游 `n` 照旧是 1；同一次运行的几张共用一个 `imageBatch.batchId`、都记节点自己的指纹，跟内核 `runtime/image-candidate-batch.ts` 认的格式一样。几张并排跑，每张各占工作流并发的一个位子，生图服务那边照旧最多同时 2 个。一张失败不停别的、不重发；全出齐才算成功，出不齐节点失败，写「这次要出 N 张，出来 X 张，Y 张没出来：原因」（`canvasImageBatchFailureMessage`）；点停止后还没发出去的不再发。
- 缓存按张分开存（`canvasImageCandidateCacheKey`）：第 1 张就用节点指纹，所以以前单张的缓存照旧能用、从 1 张改成 3 张只补发 2 张；第 2～4 张各有自己的键。所以一组没出齐以后，整个工作流再运行时只补没出来的那几张；「运行到此」的目标节点（包括运行记录里的「重新生成」）整组重出。同一张图不会同时占两个位置。画布上选中的那张：在这一组里就交给下游；整组都有缓存但选中的是更早一组的，照单张节点的办法证明后单独复用（证明不了就停下、不扣费）；一张缓存都没有（比如复制出来的项目）但能证明的，也复用那一张、不记缓存，免得下次补发剩下几张。
- 单次运行的远程生成上限按张数算（`canvasRunRemoteGenerationUpperBound`，一个 4 张的节点算 4 次），上限还是 64，超了写「这次运行最多要生成 N 次，一次运行最多 64 次（一次出几张的按张数算），请分几次运行」。工作流版本号（`computeCanvasGraphRevision`）带上张数，1 张时不变。
- 内核里多张的说明字改大白话在 xingmang-canvas #40，随 kernel-v0.1.5 同步进来；同步以前节点上仍是内核 v0.1.4 的字。
