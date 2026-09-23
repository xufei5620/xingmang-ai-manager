## 用户

- 对话里某条 AI 回复特别长（超过 4 万字）之后，再发消息会直接提示「新建对话后继续」，不再一直说「请稍后重试」。
- 聊天时断网或网络拦截，提示会说清是网络哪里不通、下一步做什么，不再叫你去查登录和 Key。
- 画布「剧本解析」：点停止能在发出请求前停下；超时会说超时而不是「已取消」；回复没收完不再当成解析成功；请求本身失败（断网、超时、余额不足）不再自动再发一次多扣钱，只有模型答的表格读不懂时才再问一次。

## 开发

- Q23（全面检测 9-23）：`chat/state.ts` 的 `planTurn` 在发出前查单条长度，超过 `AI_CHAT_LIMITS.messageLength` 直接给中文提示，不再落到 `ai-chat-protocol.ts` 的英文 `message is too long`。
- Q24：`ai-chat-service.ts` 的 `completeOnce` 在准备 Key 之前就接上停止信号和总超时，发请求前再查一次；总超时单独报 `total-timeout` 文案；只认 `[DONE]` 或 `finish_reason` 为完整，否则按 `stream-closed` 失败。`canvas-node-executors.ts` 剧本解析只在解析失败时重发，请求失败不重发。canvas-v2 未改。
- Q26：`credentialFailure` 认得出网络原因就用 `networkFailureMessages` 那句、错误码 `network-error`；渲染层 `chatErrorMessage` 对 `network-error` 认出这句时原样上屏。
