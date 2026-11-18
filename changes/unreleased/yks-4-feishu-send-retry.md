## 开发

- 0.2.24 深查 手机遥控.md YKS-4：`codex-remote-feishu.ts` 的 `send` 以前只在令牌失效时重来一次，断网、超时、5xx、限流
  直接报错，审批卡发不出去在 `codex-remote-service.ts` 里当「拒绝」。现在断网和超时（`transientFeishuRequestFailure`，
  拿令牌那一步断网也算）、HTTP 429 / 5xx、飞书文档里说「稍后重试」的 99991400、230020、1500、230049
  （`classifyFeishuSendResponse`）各等 1 秒、4 秒再发，最多两次；参数、权限、对方不收这类照旧直接报错。令牌失效那次刷新照旧，
  不占重发次数。每条消息带一个 `uuid`（飞书发消息接口：同一 uuid 一小时内至多发成一条，最长 50 字），重发用同一个，
  第一次其实已经送到时手机上不会出现两条。重发前的等待可注入（`FeishuChannelOptions.sleep`），日志只记状态码、code 和原因，
  不记正文（I13）。
