## 开发

- 视频剪辑第 1 期 PR1：renderer-v2 新增拼片引擎 `features/video-studio/`，把几段片段拼成一个 MP4
  （统一画面比例、裁边或补黑边、剪头尾、烧字幕、声音重采样后接上，没声音的片段补静音），在后台线程里跑。
  编解码用 Electron 自带的 WebCodecs，画面优先 H.264、声音优先 AAC（Linux 没有就用 Opus），不装 ffmpeg；
  读写 MP4 用新加的开发依赖 mediabunny（MPL-2.0，打进页面，不改源码）。页面和主进程的出片流程
  在后面两个 PR。新增浏览器回归 `video-studio/browser-check.mjs`。
