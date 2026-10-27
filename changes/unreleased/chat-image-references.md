## 用户

- 聊天里「生成图片」可以带参考图了：加图片或粘贴截图，写上要怎么改，就照着这张图改；
  对话里生成的图点「拿这张接着改」能接着改。要选能改图的模型（GPT 图片、Grok 图片）。

## 开发

- `chat:generate-image` 多收一个可选的 `sourceAssetIds`（1–4 个主进程发过的图片编号，`ipc/parsers/ai-chat.ts` 的
  `parseAiChatImageInput` 校验格式和重复），带了就走 `imageService.edit`（Images API edits，按账号 `readOwned` 读图，型号
  不能改图在生图服务里再拒一次）。没加通道。渲染层 `canEditImages` 决定能不能加参考图，`planTurn` 把参考图带进这一轮、
  重新生成照原图再改。
