## 用户

- AI 聊天能发图片了：点输入框旁的图片按钮选图，或者直接把截图粘贴进输入框，一条消息最多 4 张，太大的图会自动压小。只有能看图的模型才能发，选了看不了图的模型时按钮会灰掉并说明原因。带图片的提问会比纯文字贵一些。

## 开发

- 第十二批第 6 条。`ai-chat-protocol.ts` 的消息新增 `images`（本账号资产标识），`supportsChatImageInput` 按型号认能看图的模型（claude、gpt-4o/4.1/5 以上、o1/o3/o4-mini、gemini、grok-4、*-vl/*-vision），认不出的一律当看不了；单条 4 张、一次请求 8 张。发送时主进程按凭据里的账号读图转成 data URI（`toChatCompletionsWireBody`），纯文字消息的请求体与以前逐字节一致。当前这条的图读不到就在付费请求前停下（`image-unavailable`），更早消息里读不到的图换成一句说明。
- 新增 `electron/ai-chat-attachments.ts` 与两条通道 `chat:pick-images` / `chat:paste-image`：图片只从系统选文件框和剪贴板在主进程里取，渲染层给不出路径或字节；长边超过 2048 或超过 2 MB 的用 nativeImage 压（先 PNG 再 JPEG），存进本账号的图片资产目录（`AiAssetStore.readLocalFile` / `storeLocalBytes`，按内容去重）。聊天记录里只存引用；「搬到新电脑」导出不带聊天里的图片，口径不变。
