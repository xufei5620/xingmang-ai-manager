## 开发

- #1059 第 2 段「认不出的视频型号被当成聊天模型」：`resolveAiModelCapability` 认不出、名字又一看就是视频的型号
  （`UNRECOGNIZED_VIDEO_MODEL_PATTERN`：`video` / `veo` / `kling` / `vidu` / `seedance` / `hailuo` / `t2v` / `i2v` 整段词、
  `sora` 带版本号、`minimax-h<数字>` 开头），以前落到最后当成 `kind: 'chat'`，现在仍归 chat 但标成 `available: false`、`hidden: true`。
  `selectAiChatModelsForGroup` 本来就滤掉 hidden，所以对话不再列它，主进程发请求前对分组型号的核对也不再放它过；`buildChatCompletionsRequest`、
  `supportsChatImageInput` 也看 `available`。`ChatModelCapability` 的这两个字段从字面量 `true` / `false` 放成 `boolean`。
- 只收紧：藏起来不等于认得出，这些型号照旧不能拿去生成视频（`buildVideoGenerationRequest` 仍报 `model-not-video`）。
  按前缀把它们认成视频型号是另一条，要放宽校验，等 yoyo。`minimax-m2`、`sora_image` / `sora-image` 这类聊天接口的型号不受影响。
