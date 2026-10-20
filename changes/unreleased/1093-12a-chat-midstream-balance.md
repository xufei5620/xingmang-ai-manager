## 用户

- 历史账号余额不够时，AI 对话和生图都直接说余额不足、充值后再试，对话页旁边给「去充值」：以前排队等了一会儿才发现余额不够时只说「AI 服务暂时无法完成请求」；余额快用完时有时说成没有权限用所选模型、冒出一句英文，或者说服务提前结束了本次响应，照着换密钥、换分组、重试都没用。

## 开发

- 对话流到一半的报错帧也认余额不足（#1093 第 12a 条）。对过 Sub2API（Wei-Shaw/sub2api 270eac6、b0a02a3）：流式请求等并发槽位超过
  10 秒时先回 200 和心跳，拿到槽位后再复查计费（`CheckBillingEligibility`、在途余额预留），余额不够只能在流里发
  `{"error":{"type":"billing_error","message":"insufficient balance"}}`，以前 `parsedDelta` 一律报「AI 服务暂时无法完成请求」。
  新增 `classifySub2apiBillingFailure` 只认这一帧，换成现成的 `relayQuotaFailureMessages.balance`，聊天页认得它、给「去充值」。
  只在历史账号站认（`createAiChatService` 新增可选 `backend`，`main.ts` 传 `definition.backend`）：new-api rc.45 预扣费在开流之前
  （`PrepareRequestBilling`），开流后只结算不报错，xm 站流里出现这句只可能是渠道上游原样转回来的。
