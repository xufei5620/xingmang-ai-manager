## 用户

- 账号服务器以后升级到新版本时，登录、注册、充值、Key 这些地方的出错提示照样是中文，不会突然变成英文。

## 开发

- new-api 从 v1.0.0-rc.43 起控制台接口的 `message` 一律回英文原句，翻译交给网页前端按 `message_key` + `message_params` 去查 `web/src/i18n/locales/zh.json`。新增 `electron/new-api-messages.ts`：收了星芒调用的那些接口会回的提示（各接口的处理函数、全部 middleware、它们写到的 model），中文取上游 rc.44 的 zh.json 原句；和 rc.40 后端的中文对过，除了英文词两边的空格和几处 ID/邮箱字段名，字都一样。只收 rc.40 时就用中文回的句子：rc.40 本来就回英文的安全操作报错（`writeSecurityOperationError` 那一类）不收，升级后跟今天一样。发码限流那句用 rc.40 的「发送过于频繁，请稍后再试」，因为登录框按「频繁」认限流。安全验证中间件（`securityProofError`）回的三句不带 `message_key`，按原句另收一张小表。
- `new-api-client.ts` 的 `unwrapEnvelope` / `unwrapPublicNotice` / `unwrapLegacyBusinessEnvelope` 上屏那句先按 `message_key` 换中文，换不了（老服务器、没见过的 key、参数缺了或不是普通值）照旧用 `message`，不吞英文原句。换出来的中文照旧过 `sanitizeUpstreamMessage` 打码，`message_params` 里回显的密钥一样会被遮掉。登录被拒（`loginRejectionMessages`）和两步验证第二步的分类仍看英文原句。
- 老服务器（rc.42 及以前）不带 `message_key`，行为不变。
