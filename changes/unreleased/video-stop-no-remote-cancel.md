## 用户

- AI 工作区用 MiniMax 生成视频时，提示不再说「停止时会向服务端请求取消」：已经提交的视频取消不了，点「停止」只是不再等，
  视频照常生成和计费，下次打开星芒会自动取回。现在和 Grok 视频一样提示「停止等待不等于取消已到达服务端的生成任务」。

## 开发

- AI 工作区视频的「停止」不再向服务端发 `POST /v1/videos/{id}/cancel`：new-api 没有这条路由，默认线路和直连
  （xm-direct）都回 404「Invalid URL」，服务端 2026-10-06 确认取消视频在两条线路上都不生效。以前只有 MiniMax 会发，
  失败被吞掉，客户看不出区别；现在 `ai-video-service.ts` 停止只停本机等待，任务记录照旧留着、下次启动接着取回视频，
  `ActiveVideoRequest` 也不再存 API Key 和 provider。`AiVideoCancelResult.canceled` 补了注释：只表示本机不再等，
  界面不能据此说「取消成功」。
- 星芒自己的代码里没有调用 Gemini 的 `:countTokens`（也没有 Claude 的 `/v1/messages/count_tokens`），写给 Gemini CLI
  的配置也不涉及它。Gemini CLI 0.60.0 自己调 countTokens 失败时会改用本地估算（看的是安装包代码，没实测）。
- 画布（canvas-v2）MiniMax 视频生成中那句「停止时会向服务端请求取消；生成中的任务可能需要短暂等待才进入已取消状态。」
  换成 Grok 视频现成的那句（`canvas-v2/src/nodes/WorkflowNodes.tsx`），两种视频显示同一句。yoyo 2026-10-06 回「改」，
  canvas-v2 只为这一句开例外。
