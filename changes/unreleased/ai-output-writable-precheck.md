## 用户

- 用 AI 生成图片或视频前，软件会先确认作品存得下来。存不下来就不发出请求、不扣费，并告诉你可以怎么办（比如在画布里新建项目、给它选一个自己的文件夹）。以前会先扣费，生成完才发现存不下来。
- 「检查」页新增「AI 作品保存位置」一项，能看出生成的作品现在存不存得下来。

## 开发

- 盲点 2 前半（可能没想到的问题-2026-09-22 第 2 条）：`AiAssetStore.assertWritable(userId?)` 在 `user-<id>` 目录（无 userId 时为 output 根）经 `ensureSafeDataDirectory` 后以 `wx`/0o600 真写一个随机名探针再删，失败抛带 `code: AI_OUTPUT_UNWRITABLE` 的中文错误，OS 原因留在 `cause`。下一步文案由宿主通过 `unwritableGuidance` 给：全局 output 指向画布项目，项目文件夹指向换文件夹。
- 聊天生图（`imageService` 直接用 `AiAssetStore`）、画布生图与画布视频（`CanvasProjectAssetManager.assertWritable`）在发请求前调用；`prepareProject` 语义不变，视频续查已付费任务不试写。
- 启动时由试写替换原先只建目录的 `ensureOutputDirectory`，失败仍记 `asset.output-directory.unavailable` 并带上 OS 原因；诊断新增可选依赖 `probeAiOutput` 与检查项 `AI_OUTPUT`（写不进标 warn，不进开机提示）。渲染层 `chatErrorMessage` 原样透出这句提示。默认保存位置不变，搬家另走第二个 PR。
