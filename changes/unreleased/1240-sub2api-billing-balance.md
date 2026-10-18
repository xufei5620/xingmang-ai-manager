## 用户

- 历史账号余额快用完时，AI 对话和生图有时说成没有权限用所选模型、冒出一句英文，或者说服务提前结束了本次响应，客户照着换密钥、换分组、重试都没用；现在都直接说余额不足、充值后再试，对话页旁边给「去充值」。

## 开发

- 历史账号站计费复查那句余额不足，开流之前和 Claude 兼容分组排队以后也认（#1240）。对过 Sub2API（Wei-Shaw/sub2api 270eac6、b0a02a3）：
  过了鉴权以后 handler 还要复查一次计费（`CheckBillingEligibility`、在途余额预留 `reserveInflightBalance`），没过回 403
  `{"error":{"type":"billing_error","message":"insufficient balance"}}`，跟鉴权中间件那句「Insufficient account balance」不是一句，
  `classifyRelayQuotaFailure` 认不出：对话落到「当前 API Key 无权使用所选模型或分组」，生图把英文原话直接上屏。
  Claude 兼容分组排队超过 10 秒已经回过心跳时，`gateway_handler_chat_completions.go` 照普通请求回这段 JSON，不带 `data:` 前缀接在流后面，
  以前说成「AI 服务提前结束了本次响应，请重试」。
- `classifySub2apiStreamQuotaFailure` 改名 `classifySub2apiBillingFailure`，认法不变，三处共用：对话 `safeHttpFailure`（403 时）、
  SSE 解析器记下的最后一段裸 JSON（流没等到结束标记时）、生图服务（403 时，`createAiImageService` 新增可选 `backend`，`main.ts` 两个生图服务都传
  `definition.backend`）。仍然只在历史账号站认：xm 站出现这句只可能是渠道上游原样转回来的。
- 视频不用改：历史账号站的视频生成本来就关着（`main.ts` 里 `solov-api` 直接拒）。写密钥前查模型清单也不用改：Sub2API 的 `/v1/models`
  不走计费复查，余额不足只会是鉴权中间件那句，早就认得。
