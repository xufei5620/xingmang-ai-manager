## 开发

- 视频剪辑改字（0.2.24 深查 W57、W58、W59 和决定单第六节时长写法）：拼片后台出的岔子（回包读不懂、线程停了、片段交不过去、
  请求格式或编码器不对）统一报「拼的时候出了点问题，请再试一次」，收成 `errors.ts` 的 `videoStudioComposeGlitchMessage`；
  确认框「上次提交时没收到服务端答复」改「星芒的答复」。时长统一走 `timeline.ts` 新的 `formatVideoStudioDuration`：
  先整体取整到秒再拆（原来成片超长的报错会写出「10 分 60 秒」），秒不补零，到一小时写「N 小时 N 分钟」；
  成片超长的报错往上取整，只超零点几秒时不再写成「现在是 10 分 0 秒」。`timeline.test.ts`、`compose-*.test.ts`、
  `browser-check.mjs` 钉住。
