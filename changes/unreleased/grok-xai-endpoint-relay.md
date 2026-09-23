## 用户

- 用当前账号跑 Grok CLI 时，让它画图或做视频不会再卡两分钟，Key 也只发给当前账号的服务。

## 开发

- `electron/config-files.ts`：Grok 的 reset 模板与 merge 都写 `[endpoints] xai_api_base_url = <中转>/v1`。Grok 1.0.40 的 `image_gen` / `image_edit` / `image_to_video` / `reference_to_video` 不走 `[model."grok"].base_url`，而是带着同一把 `api_key` 去请求这个地址（默认 `https://api.x.ai/v1`），等于把中转 Key 发给 xAI 官方，国内不可达时还要卡 120 秒。沙箱实测改指中转后出图请求打到中转、0.5 秒返回。对应「接中转后的官方体验差距」K1。
