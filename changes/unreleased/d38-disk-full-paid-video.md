## 开发

- 决定单 D38（0.2.24 深查 作品和素材库.md S-1 的改字和量盘两件；原因进日志、图片字节暂存那两件不在这次）。用户行并进
  `d107-works-back-to-documents.md`。
- 视频片段下载下来、`storeMp4` 因为盘满（`ENOSPC` / `EDQUOT`，按 `startup-failure.ts` 的 `classifyStorageFailure` 顺着 `cause` 认）
  存不进去时，`ai-video-service.ts` 的 `downloadTask` 改报决定单那句（`ai-video-submission.ts` 的 `aiVideoDiskFullMessage`）：
  「视频已经生成、也已经扣费了，但电脑的磁盘满了存不进去。先别重新生成，清出一些空间后重开星芒，会自动取回。」
  任务记录这时本来就没删，下次登录 `resumeUser` 照旧再取一次。视频剪辑页和画布都原话上屏；对话页不出视频，不涉及。
  别的存不进去的原因（没权限、被占用）照旧是存储层那句。为此 `AiVideoAssetStore` 存不进去那句挂上原始错误做 `cause`。
- 发付费的生图、生视频请求之前（`AiAssetStore.assertWritable` 带账号那次，画布按项目那份同样走它），先量保存位置那块盘：
  剩不到 200 MB（`disk-space.ts` 新常量 `paidGenerationMinimumFreeBytes`）就停下，字沿用装工具前查盘那句
  （`describeInsufficientDiskSpace`：「C 盘空间不足，只剩……，至少需要 200 MB，请先清理 C 盘再试」），不另起新字。
  先量再试写，盘一点不剩时说的是空间不够、不是「写不进去、找客服」。量不出来照旧放行；开机和检查页那次不带账号、不量。
- 对话页 `chatErrorMessage` 认出这句原样上屏（以前落到兜底「请稍后重试」）。
