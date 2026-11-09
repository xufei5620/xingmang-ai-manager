## 用户

- 视频剪辑：每个镜头可以单独定「时长」，开头、结尾想长一点就单独调；没调的照旧跟着「每段时长」走。

## 开发

- 视频剪辑分镜卡每个镜头加「时长」下拉（只列视频模型能出的几档，yoyo 2026-11-09 回「所有的修改都按照你的推荐」）；各镜长短不一时分镜卡不写「每段 S 秒」，确认框写「生成 N 段、共 T 秒」。`project.ts` 新增 `videoStudioShotSeconds`（单独定的或「每段时长」，再挪到模型能出的一档）、`setVideoStudioShotSeconds`（定成和每段时长一样就不存，出着的不改）、`selectVideoStudioVideoModel`（换模型时每段时长和各镜时长一起挪）和 `videoStudioCommonSeconds`；出片请求按各镜自己的时长。工程存这一项，读回时校验。`project.test.ts`、`VideoStudioPage.test.tsx` 和 `browser-check.mjs` 一条（单独加长、改每段时长时没定的跟着走、确认框写总秒数、请求按各自时长、重开还在、出着时改不了）钉住。
