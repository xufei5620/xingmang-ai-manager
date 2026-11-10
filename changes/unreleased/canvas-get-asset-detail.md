## 开发

- 画布完善第 7 条第二步（#1397）的前置：新通道 `canvas-host:get-asset-detail`，内核的 `getAssetDetail` 有了桌面实现。主进程按 `canvas-host:list-assets` 同一套读法读一条素材（同一个素材库：开着项目读项目自己的；带运行来源 `lineage`；回收站里的也读出来、带 `deletedAt`，由内核自己拒），读完再核对账号没换。只读、不写，不交路径。
- `ai-media-asset-service.ts` 加 `readOwnedDetail`：先按种类提示只翻那一个仓库的索引，找不到再按图片、视频、音频依次找；读不出来的跟列表一样当不存在。
- 内核里靠它的入口跟着放出来：素材库的批量「加入画布」（`hostEntryPoints.batchAdd`）、蒙版另存后的再次核对、画廊候选素材补读。抽帧节点的「成品放到画布」和视频选帧也要它，随抽帧开关一起生效（用户行并进了 `canvas-frame-extract-on.md`）。
