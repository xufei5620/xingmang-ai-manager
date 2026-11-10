## 开发

- 拼片的起点改成 `max(0, 第一帧时间戳)`（`features/video-studio/timeline.ts` 的 `buildVideoStudioRenderPlan`）：带负时间戳隐藏前导帧的片段（编辑表、编码器预热那种），以前把藏在 0 之前的画面拼进成片开头，声音跟着往后推同样一截；声音经 `segment.sourceStart` 共用这个起点。正的起点照旧保留。#1489 总表 R2-1。`browser-fixture.ts` 的 `makeClip` 加 `lead`（0 之前藏几帧别的颜色），`browser-check.mjs` 补一条真编真拼的回归（改前成片 1.25 秒、0.1 秒是藏起来的红色），`timeline.test.ts` 钉住负起点、正起点和整段都在 0 之前三种情况。
