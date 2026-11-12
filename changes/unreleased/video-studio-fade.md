## 开发

- 视频剪辑「拼成一条视频」卡加「镜头之间」直接切 / 淡入淡出和「结尾淡出」开关（yoyo 2026-11-09 回「所有的修改都按照你的推荐」），缺省直接切、不淡，老工程读回来也是这样。拼片引擎：`timeline.ts` 新增 `VideoStudioTransition`、每段的 `fadeInFrames` / `fadeOutFrames`（镜头之间每头 0.4 秒、片尾 1 秒，短片段每头最多三分之一、片尾一半）和 `videoStudioFadeLevel`；`compose.ts` 在字幕画好以后盖一层黑，原声按每个采样点的时间跟同一条曲线淡，配乐只在结尾照旧淡出；`compose-protocol.ts` 的画面设置多收 `transition` / `fadeOut`，认不出的整个拒。工程存这两项，拼片比对键带上。`timeline.test.ts`、`compose-protocol.test.ts`、`project.test.ts`、`VideoStudioPage.test.tsx` 和 `browser-check.mjs` 两条（引擎：换段处画面和声音一起淡到黑、片尾淡出、不选时和原来一样；页面：选了以后拼出来跟着淡、重开还在）钉住。
