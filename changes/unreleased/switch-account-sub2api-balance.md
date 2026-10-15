## 开发

- `src/renderer-v2/operation-error.ts` 的 noBalance 规则补认 Sub2API（历史账号站）余额用完的原话
  「Insufficient account balance」和错误码 `INSUFFICIENT_BALANCE`。历史账号余额为零时，签好的 Key
  拿去查模型就被拒，「改用当前账号」（首页、引导第 3 步）和登录后自动写 Key 失败以前只上屏
  「操作没有完成」加英文原话；现在按余额用完给「余额已用完」和「马上充值」。主进程行为不变：
  这一步失败时配置没有写，原来的（例如 CC Switch 的）照旧留着。
