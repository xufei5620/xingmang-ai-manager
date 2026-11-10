## 开发

- 视频剪辑分镜卡每个镜头加「用一张图开头」/「换一张」/「不用这张图」（yoyo 2026-11-09「图开头改」）。选图复用对话页的 `chat:pick-images`（`pickAiChatImages`，进 `VideoStudioBridge`），出片时 `buildVideoStudioClipRequest` 带 `imageAssetIds`：Grok 当第一帧，MiniMax 从 `t2va` 换成 `i2va`；主进程 `video:generate` 本来就收参考图，没有新通道。工程只存图的编号，读回时按编号重拼地址（`videoStudioShotImage`）；一次多选按顺序填后面没图、没在生成的镜头（`assignVideoStudioShotImages`）；重写分镜按位置留图。`project.test.ts`、`VideoStudioPage.test.tsx` 和 `browser-check.mjs` 一条页面回归钉住选图、多选分配、取消选择、去掉、生成请求带图、生成中不能换、重开还在。
