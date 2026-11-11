## 开发

- 视频剪辑分镜卡生成好片段的镜头加「开头剪掉」「结尾剪掉」两个下拉（不剪 / 0.5 / 1 / 1.5 / 2 / 3 秒，yoyo 2026-11-09 回「所有的修改都按照你的推荐」）。`project.ts` 新增 `videoStudioTrimChoices`、`videoStudioTrimOptions`（剪完至少留 1 秒，片段时长读不到按每段时长）、`setVideoStudioShotTrim`（只剪生成好、没在重新生成的片段，剪的长短一变清掉挂着的成片）、`withoutVideoStudioTrim`（换上新片段时清零）和 `videoStudioTotalSeconds`（「共约 T 秒」减掉剪掉的）；拼片请求带上引擎本来就认的 `trimStart` / `trimEnd`，拼片的比对键也带上。工程跟着片段存剪掉多少，读回时整对校验。`project.test.ts`、`VideoStudioPage.test.tsx` 和 `browser-check.mjs` 一条（可选几档、拼出来的成片变短、换剪法清成片、重开还在、重新生成清零）钉住。
