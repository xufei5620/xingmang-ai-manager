## 开发

- 手机遥控读回应正文时断网不再记成「太大」（0.2.24 深查·手机遥控 YR-5）：`codex-remote-http.ts` 读正文那步以前出任何错
  （取消除外）都包成 `RemoteHttpError('oversize')`，手机上发的图下到一半断了网，飞书、微信都回「这张图片太大了，电脑没收。
  请发小一点的，或者截一部分。」；飞书发消息读回应时断了也当 oversize，不带同一个 uuid 重发，那条回复就丢了。现在用
  `readBoundedResponseBytes` 现成的 `oversizeError` 只给真超过上限的一种抛 oversize（原话不变），别的读取失败落到外层 catch，
  跟请求没发出去一样按 `network`（超时、取消照旧）。取图失败走现成的「这张图片电脑没取到，请再发一次。」，飞书、微信发消息按
  断网重发。不加新字，不动 `network-failure.ts`（这里不按原文归类，只分「超限」和「别的读取失败」）。
  `codex-remote-http.test.ts`、`codex-remote-feishu.test.ts`、`codex-remote-weixin-api.test.ts` 钉住。
