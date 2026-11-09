## 用户

- 断网、网络解析不出地址、代理没开或被公司网络拦下时，出图和出视频不会再说「提交结果不明确，可能已经扣费，请勿重复提交」：这种时候请求根本没发出去，不扣钱，现在会照实说是网络哪里没通，网好了直接再点一次就行；视频剪辑里那一镜也不会再一直挂着「结果不明」。对话回复到一半网断了、或者被拦到上网认证页时，也不再说「AI 服务返回了无法识别的数据」，改说网络哪里没通或者回复提前断了，点「重新生成」就好，前面已经收到的字照样留着。

## 开发

- 网络异常深查 W-1、W-2（`/mnt/project-files/0.2.24-深查/网络异常.md`）。只改判断，文案全用 `network-failure.ts` 和聊天里现成的句子，没有新字。
- W-1：`relay-line-fetch.ts` 导出 `unsentRequestFailure`，跟会改动数据的请求换线路重发用的是同一个 `provablyUnsent`，只多认 `ERR_PROXY_CONNECTION_FAILED`（代理软件没开，连代理都没连上；换线路没用，所以那边不认）。`ai-image-service.ts` 生图、改图 POST 抛错时先问它：请求肯定没送到就把 `dispatched` 退回 false、抛 `networkFailureMessages[原因]`，送没送到说不清的（连接被重置、握手被掐断、超时、`TimeoutError`、网络切换）照旧说「结果不明确」。`ai-video-service.ts` 同理，另外先 `forgetSubmission()` 清掉「结果不明」那条记录（更早一次不明确的提交留着），不再给这一单记用量刷新。
- W-2：`ai-chat-service.ts` 发请求就失败按 `classifyNetworkFailure` 说原因（认不出照旧「无法连接 AI 服务」）；200 却回网页的说 `intercepted`；读回复正文时抛的错按网络原因说，认不出的（`ERR_INCOMPLETE_CHUNKED_ENCODING`、`ERR_CONTENT_LENGTH_MISMATCH` 这类 `network-failure.ts` 不归类的）照 `stream-closed`「AI 服务提前结束了本次响应，请重试」说，只有解析出错才是「无法识别的数据」。`completeOnce`（画布文字节点）发请求失败、回网页同一套，读正文抛错认不出的照旧说「无法连接 AI 服务」（它从不交回半截）。渲染层 `features/chat/state.ts` 的 `chatErrorMessage` 在没有错误码时认出 `network-failure.ts` 那几句原样上屏（对话页出图走这条）。
- 没做：两条线路都被拦到认证页、生图拿到 200 网页那种（深查里「顺带一种情况」）：生图的回应只要是 200，就分不清那张网页是不是中转转回来的上游原话（推测透传渠道可能这样），说成没扣钱一旦说错客户就再扣一次，照旧说「结果不明确」；`network-failure.ts` 补 `ERR_HTTP2_*` 等错误码属于 W-7，不在这次里。
