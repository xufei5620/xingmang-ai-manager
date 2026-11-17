## 开发

- 付过钱的图存不进作品库、已经暂存好了时，对话和画布上屏那句换成（深查 S-1，yoyo 2026-11-17 回「暂存改」）：
  「图片已经生成、也已经扣费了，但没能存进作品库，已经先替你收着。先别重新生成，清出一些空间后会自动存进作品库。」
  （`ai-image-service.ts` 的 `aiImageKeptUnsavedMessage`）。`AiAssetStore` 的 `keepUnsaved` 改成回 true / false，
  收下了就把错误的 code 换成新导出的 `AI_IMAGE_KEPT_UNSAVED_ERROR_CODE`，生图那边按它换句；没收下（暂存也放不下）
  照旧是「图片已生成但本地保存失败……请勿立即重复提交」。
- 对话页 `chatErrorMessage` 认「先别重新生成」原样上屏，排在按字面猜的几条前面；不然会落到兜底「请稍后重试」，
  客户照做就再扣一次钱。用户行并进 `d107-works-back-to-documents.md` 那条。
