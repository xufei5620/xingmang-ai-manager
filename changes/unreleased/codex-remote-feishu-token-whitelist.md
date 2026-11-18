## 开发

- 手机遥控 YR-4：飞书换访问凭证（`tenant_access_token/internal`）原来只要 code 不是 0 就抛 `FeishuAuthError`，
  限流、飞书内部出错也会走 `failAuth` 把遥控整个停掉、卡片改成「App ID 或 Secret 不对」。改成白名单
  `tokenCredentialCodes`（照飞书通用错误码表：10003、10005、10014、10015、20002、50003），只有这几个才停；
  别的 code 和没有 code 的应答都抛 `FeishuTokenResponseError`（带上 status 和 code，`feishu.token-failed` 进日志），
  遥控照旧开着。`transientFeishuRequestFailure` 把换凭证时的 429、5xx 和 `tokenRetryCodes`（99991400、1500、10500）
  算成 `token-unavailable`，`post()` 按 `sendRetryDelaysMs` 等一会儿再换再发，补上 YKS-4 漏掉的这一处。保存凭据时
  碰到这些照旧只说 `feishuSaveFailedMessage`，日志多记 code。不加新字；用户行没有另起（60 条已满）。
