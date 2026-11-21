## 开发

- 给客户看的那句并进了 `n7-image-ignores-history-length.md` 的「## 用户」（一版最多 60 条）。
- 0.2.25 总单第 24 项（11-18 复核 D10）：中转回的 `finish_reason` 以前只看有没有，`length` / `content_filter` 跟 `stop` 一样当说完。
  新增 `electron/ai-answer-cut-off.ts`：`resolveAnswerCutOff` 把 `length` / `max_tokens` / `max_output_tokens` 认作到了长度上限，
  `content_filter` / `safety` / `refusal` 认作被内容审核拦下（new-api 不认识的原因会原样透传，所以连上游原名一起认）。
- 流式聊天：`complete` 事件带 `cutOff`（主进程事件、`ipc-contract.ts` 的 `AiChatStreamEvent`、`bootstrap/ai-services.ts` 转发三处），
  `chat` 日志的 `stream.complete` 也记一份。聊天页消息存 `cutOff`（随本机记录和「搬到新电脑」带走，旧版本读到会忽略），
  回答下方加一行提示；已返回的字照留，接着写要客户自己发「继续」，不自动再发付费请求。没有新增 IPC 通道，只给已有事件加了一个可选字段。
- `completeOnce`（画布文字节点、剧本解析、写分镜）：被截断时抛 `AiAnswerCutOffError`，不把半截当整段交回；
  剧本解析和写分镜以前读不懂会自动再问一次，截断时不再重发（再问多半照样截断，还多扣一次钱），各自换成说清怎么改的那句。
  画布文字节点报错时半截字不保留：画布节点没有同时放半截结果和提示的地方，要留得改 xingmang-canvas 内核。
