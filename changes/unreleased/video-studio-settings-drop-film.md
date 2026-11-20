## 用户

- 视频剪辑拼好成片后再改字幕大小、位置、转场或画面比例，页面上不再挂着对不上的旧成片。

## 开发

- `video-studio/project.ts` 新增纯函数 `changeVideoStudioSettings`：改设置前后各算一次 `videoStudioComposeKey`，不一样就清掉
  `exported`，同剪片段、换配乐那几处；只换模型、改想法、镜头数、每段时长这类拼片用不上的，成片照旧挂着。`useVideoStudio.ts` 的
  `changeSettings` 改走它（Mac 验收 R8，0.2.25 总单第 50 项）。`project.test.ts` 补一条逐项核对；`browser-check.mjs` 的转场、字幕
  两条用例拼完重开后再改一次设置、断言成片撤下，旧代码上红。
