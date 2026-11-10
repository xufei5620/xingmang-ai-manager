## 开发

- 视频剪辑页头加「新建一条」，页面最下面加「草稿箱」卡（yoyo 2026-11-09 回「所有的修改都按照你的推荐」）。`project.ts` 新增草稿箱的纯函数（`startVideoStudioProject` / `openVideoStudioDraft` / `removeVideoStudioDraft`、存取 `serializeVideoStudioDrafts` / `restoreVideoStudioDrafts`，最多 20 份，空工程不进草稿箱），手上那一份照旧存在原来那一格，草稿箱另存 `…:drafts`。`useVideoStudio.ts` 只在手上没事在跑时换，先写草稿箱、存不下就不换；换回来的草稿里记着请求号的片段照重开页面那样接回（只查不提交）；选图、选歌对话框开着时换了草稿，选回来的不挂上去。教程「视频剪辑」一章最后一步的补充说明跟着讲新建和草稿箱。`project.test.ts`、`VideoStudioPage.test.tsx` 和 `browser-check.mjs` 一条（新建、重开还在、草稿里没等到的那段换回来时接回不再付钱、生成和接回时不能换、删掉先确认）钉住。
