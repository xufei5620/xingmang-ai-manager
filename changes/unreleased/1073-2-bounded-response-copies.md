## 开发

- #1073 第 2 条：响应体大小上限的最后 5 份自写副本（`ai-image-service.ts`、`ai-asset-store.ts`、
  `ai-video-service.ts`、`grok-update.ts`、`sub2api-account-client.ts`）换成共用的 `bounded-response.ts`。
  共用版加了三个可选项：`requireNonEmpty`（没有响应体、读完是 0 字节各报各的那句）、`oversizeError`（超限抛带类型的
  错误，历史账号客户端靠它照旧抛 `RealmAccountError`）、`guard`（每读一块跟停止信号赛跑并回调 `onChunk`，视频下载的
  空闲计时和历史账号客户端的块数上限都走它；原来在 `ai-video-service.ts` 的 `raceAbort` 一起搬过来）。各处报错原样不变。
  共用版顺手补齐两处：声明长度超限时也把没读的响应体关掉；读到一半出错也关掉。历史账号客户端停了以后才回来的
  响应也会被关掉，不再留着一条没人读的连接。
