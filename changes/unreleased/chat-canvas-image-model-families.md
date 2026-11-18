## 开发

- AI 对话和画布按名字规则认出站上新加的出图型号（`ai-chat-protocol.ts` 的 `resolveAiModelCapability`）。以前只认
  gpt-image、即梦、Grok 出图和写死的 `gemini-3.1-flash-image`，nano-banana、新版 Gemini 出图、豆包 seedream、Flux、通义 qwen-image
  这类被当成文字模型：图片分组里不列，硬拿来出图报「当前模型不支持图片生成」。用户更新说明已满 60 条，这条只记开发侧。
- Gemini 系（`nano-banana*`、`gemini-*-image*`，规则跟画图技能的 `GEMINI_IMAGE_MODEL_PATTERN` 同一条、测试钉住）照
  `gemini-3.1-flash-image` 的接法走 `/v1/chat/completions`，1K/2K/4K 和十种比例照旧；Gemini 2.x（含 `nano-banana` 原版）只开 1K，
  请求里不带 `image_size`。对话接口要出图，站上 new-api 的「支持出图的 Gemini 模型」表里得有它映射到的上游型号，默认就有
  2.5-flash-image、3-pro-image(-preview)、3.1-flash-image(-preview)（对 rc.44 源码核过）。
- 别家（`dall-e-*`、`imagen-*`、`qwen-image*`、`z-image*`、万相 `*-t2i`、`flux`、`seedream`，照 new-api 的 `ImageGenerationModels`
  再加 seedream）走 `/v1/images/generations`，新 provider `images-api`：只发 `model`、`prompt`、`n`，尺寸和画质交给服务按型号默认值定
  （界面上是「自动尺寸」，跟 Grok 一样），不支持改图。改图专用的（`qwen-image-edit*`、`wan2.6-image`、`*imageedit`）不认。
- 名字像视频的照旧藏起来，视频型号的认法没动（#1059）。对话模型菜单和图标把 `nano-banana*` 归到 Gemini。
