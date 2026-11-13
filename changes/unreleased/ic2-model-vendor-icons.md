## 开发

- 深查 IC-2（查图标和图片素材）：聊天、视频剪辑的模型按钮和 AI 回复头像，按模型名认厂商的那份前缀（`ui/brand.tsx` 的 `modelBrand`）
  补齐到跟模型菜单分节（`features/chat/state.ts` 的 `vendorPatterns`）一致：`dall-e`、`sora`、`o` 加任意数字画 OpenAI，`imagen`、`veo`
  画 Gemini，`qwq`、`qvq` 画通义，`cogview` 画智谱，`abab`、`hailuo` 画 MiniMax，以前这些都是问号圆圈。只用仓库里现成的厂商标，没加新图；
  即梦在 `vendor-icons.tsx` 里没有现成的标，仍是问号。`components.test.tsx` 加一条：菜单归到某家的模型，图标必须画那一家的标。
