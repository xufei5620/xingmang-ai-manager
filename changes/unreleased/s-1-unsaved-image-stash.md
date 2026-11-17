## 开发

- 付过钱的图存不进作品库时先暂存、腾出空间后补存（0.2.24 深查 作品和素材库.md S-1 第 4 条，汇总决定单 S-1 照推荐）。
  以前生图回来的 base64 或下载下来的图在 `AiAssetStore` 写盘失败就跟着错误一起丢了，客户已经扣过费。
- 新模块 `electron/ai-unsaved-image-stash.ts`（`AiUnsavedImageStash`）：先写进软件自己数据文件夹（按站点那层）的
  `ai-unsaved-images/user-<id>/<内容 sha256>.<扩展名>`，原子写、过 `safe-local-data` 的联接检查（I8）；那里也写不进
  （同一块盘满了）就留在内存里。盘上 512 MB、内存 128 MB 封顶，超了这一张照旧丢、记一行日志。
- 补存：登录（含开机自动登录）时 `main.ts` 调一次 `flush(userId)`；软件开着时按 1、5、15、30 分钟（封顶）自己再试，
  都存好就停。补存走作品库自己的 `storeLocalFile` / `storeLocalBytes`，按内容定编号，补存到一半退出也不会多出一张；
  暂存目录里被人放进来的链接、硬链接由 `storeLocalFile` 原有的检查挡掉。存好了才删暂存文件。
- 只接扣过费的两条路（`storeBase64`、`storeRemoteUrl`），而且只在校验已经过了、写盘那一步失败时（新的内部 code
  `AI_IMAGE_WRITE_FAILED`）；本机导入、主进程自己做的图不暂存。对话和画布项目两边的 `AiAssetStore` 都经新选项
  `keepUnsaved` 交给同一份，统一补存进账号作品库（画布项目文件夹写不进多半是文件夹本身出了状况）。
- 运行日志新增 `ai-chat/asset.unsaved.kept|dropped|restored|restore-failed`。暂存好了时上屏那句见
  `s-1-kept-image-wording.md`；没暂存上的照旧是「图片已生成但本地保存失败……」。
