## 用户

- 服务在维护或线路繁忙时，软件会直接说「服务暂时不可用，你这边不用做任何改动，稍后再试就行」，不再误报成 Key 失效、登录过期或账号密码错误，也不再让你去重新写入 Key。连接自检、首页、账号页和 AI 对话都是同一句话。

## 开发

- `electron/network-failure.ts` 新增 `serviceUnavailable` 一类与 `isServiceUnavailableResponse`：502/503/504、CDN 的 520–526、5xx 却不是 JSON、带 `cf-mitigated` / `server: cloudflare` / 验证页特征的 403 都算；2xx 永远不算（回网页仍按门户拦截，与检查页读状态接口的判法一致）。文案刻意不带「登录 / Key / 网络」等字，免得被渲染层的兜底正则认回别的类别。
- 账号请求（`new-api-client.ts` 三个 unwrap、`sub2api-account-client.ts` 新 `UNAVAILABLE` 码）、连接自检（新层 `service`，不给「去处理」也不给「重新写入 Key」；带分组字样的 JSON 503 仍归分组层；2xx 回网页改归门户拦截）、模型查询（`fetchAvailableModels`）、AI 对话（新错误码 `service-unavailable`，准备分组失败时也认）统一按这一类报。
- 渲染层 `operation-error.ts` 新增 `serviceUnavailable`，「无可用渠道」从 `keyInvalid` 移出（上游渠道被自动禁用时 new-api 报的就是这句，换 Key 无用）；`chat/state.ts`、`account-read-error.ts` 在按字面猜之前先认这一类。
- 「可能没想到的问题」第 3 条的客户端部分之一；启动时非 401 保留登录并退避重试另起一个 PR，维护状态文件等拍板。
