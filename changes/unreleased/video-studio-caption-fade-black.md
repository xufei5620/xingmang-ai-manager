## 用户

- 视频剪辑开着字幕又选了淡入淡出或结尾淡出时，成片换镜头和片尾会淡成黑色，不再淡成白色。

## 开发

- 拼片逐帧画（`video-studio/compose.ts` 的 `renderSegmentFrames`）在盖淡入淡出那层之前把填充色设回黑色。
  `paintVideoStudioCaption` 画字幕时把 `fillStyle` 换成了白色，那层用的是同一个画布上下文，开着字幕的片段
  换段和片尾就淡成白的（Mac 验收 R4，0.2.25 总单第 9 项）。没字幕的片段不受影响，所以原来的淡入淡出用例没抓到；
  `browser-check.mjs` 补了一条两段都带字幕的。
