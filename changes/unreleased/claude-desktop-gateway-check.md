## 用户

- Claude Desktop 的连接自检改成和 Claude Desktop 自己启动时一样，发一条一个字的测试消息。账号余额不足、密钥失效这类情况，星芒会直接说出原因；以前这时星芒显示「正常」，Claude Desktop 却提示「Couldn't sign in to Gateway」。每次自检花这个模型一个字的额度，和 Claude Code 的自检一样。

## 开发

- Claude Desktop 的连接自检（保存后复测与检查页同一条路）从 `GET /v1/models` 改为照抄 2.9939.4 网关启动探测的那条请求：`POST /v1/messages`、`Authorization: Bearer`、`anthropic-version: 2023-06-01`、内容 `.`、`max_tokens: 1`（`connection-check.ts` 的 `gatewayMessagesShape` / `buildGatewayMessagesProbe`，`external-client-connection.ts` 的 `probeFor` 按客户端穷尽分派）。
- 原因：桌面端网关探测对静态密钥的 401 与 403 一律报「The provider rejected your credentials」（`LUt(403, 有 expiryHint)` 为假，不算「授权不足」）；new-api 查模型清单不走计费，账号余额不足时清单 200、消息 403「用户额度不足」，旧自检因此假绿。归因沿用 CLI 共用的 `classifyConnectionResponse`，403 带额度字样落到「额度」层。
- WorkBuddy / OpenCode 仍查模型清单、不花额度。成功结论的 evidence 按客户端写明问的是哪一句（`verifiedWording`）。
