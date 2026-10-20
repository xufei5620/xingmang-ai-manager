## 用户

- AI 对话的图片分组里，站上新出的图片模型（比如以后的 gpt-image-3）也会列出来，排在原来那几个后面；让 AI 用新型号画图时，星芒画图工具也认得，不再拒绝或悄悄换回 gpt-image-2。

## 开发

- #1059 两条放宽（yoyo 10-20 北京 17:41 回「四条都放」）。「图片型号放开」：`selectAiChatModelsForGroup` 的 `IMAGE_GROUP_MODEL_ORDER`
  只管先后，名单外 `resolveAiModelCapability` 认得出的图片、视频型号（不是 chat、没藏起来）按账号列表次序接在后面；
  `grok-imagine-video-*` 按前缀认成 Grok 视频（`source: 'fallback'`，跟 `grok-imagine-video` 同样 1–15 秒、能带一张参考图）。
  「画图脚本放开」：`mcp-server.mjs` 去掉写死 5 个的 `ALLOWED_MODELS`，改用和主进程、`generate.mjs` 同一条 `OPENAI_IMAGE_MODEL_PATTERN`，
  schema 的 `model` 不再列枚举；主进程自动挑的型号不变（flare → gpt-image-2 → sunburst → gpt-image-1）。
  测试钉住三处规则一致。其他校验不动，画布（canvas-v2）不动。
