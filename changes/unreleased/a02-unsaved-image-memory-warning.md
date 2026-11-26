## 用户

- 生成的图片未能存入作品库时，星芒将稍后自动补存；如无法暂存，将提醒您暂勿退出星芒，以免图片丢失。

## 开发

- 付过钱的图存不进作品库时，`AiUnsavedImageStash.keep` 收在哪（`disk` / `memory`）原样交回 `AiAssetStore`
  （`keepUnsaved` 从回 `boolean` 改成回 `AiImageKeptPlace | null`）：收在盘上照旧挂 `AI_IMAGE_KEPT_UNSAVED`，
  只留在内存里改挂新的 `AI_IMAGE_KEPT_IN_MEMORY`，`ai-image-service.ts` 据此换成 `aiImageKeptInMemoryMessage`，
  多说一句「一退出就没了，先别退出星芒」（11-18 复核 A02，0.2.25 总单第 61 项，yoyo 11-20 回「暂存改」）。
  以前两种都是同一句「已经先替你收着」，只在内存里的客户退出就丢了。新句子保留「先别重新生成」，对话页 `chatErrorMessage` 原样上屏，
  画布节点照旧显示主进程原话。收在盘上的那句一个字没动。
