## 开发

- AI 对话图片分组的模型精选（`ai-chat-protocol.ts` 的 `IMAGE_GROUP_MODEL_ORDER`）加上 `gpt-image-2.5-flare` 和
  `gpt-image-2.5-sunburst`：xm 站两个分组都开了这两个型号，以前「图片模型」分组被精选名单筛掉、下拉列不出来。
  排序照星芒AI生图（#999）的取舍：flare 第一、gpt-image-2 第二、sunburst 第三。「GPT」分组不走精选，本来就列得出。
  画布的下拉只列它自己预设表里有的型号，不受影响。
- AI 对话画图的默认模型跟星芒AI生图一致：分组里有 `gpt-image-2.5-flare` 就默认用它，没有照旧 `gpt-image-2`
  （渲染层 `DEFAULT_IMAGE_MODELS`，`resolveChatModel` 的首选改成可传一串）。对话里记住的模型照旧优先，
  已经在用 gpt-image-2 的对话不会被换掉。两者按张计价一样。
- `buildImageGenerationRequest` 把 `gpt-image-2.5-*` 也按 gpt-image-2 换算 2K/4K 尺寸（与生图技能的
  `isGptImage2` 一致）；以前它们在界面上能选 2K/4K，请求里却仍是 1K 尺寸。
