## 用户

- 原来照教程给 Codex 配过别家中转、用环境变量或请求头带别家密钥的，改用星芒账号后不再一用就报 401：星芒另起一份自己的连接，原来那份原样留着。以前在那份连接下的 Codex 对话暂时不在「继续」列表里，对话本身还在。

## 开发

- Codex「只更新」不再接管带别家凭据的 `model_providers` 表（#1083，yoyo 10-18 定「另起一张」）。以前 `codexRelayProviderFor`
  只要正在用的表名不是内置名就沿用它，`applyCodexRelayConfig` 只改 name / base_url / wire_api 等，`env_key`、
  `experimental_bearer_token`、`http_headers` 这些原样留着：地址换成星芒，请求带的还是别家的 Key。
  现在 `config-files.ts` 新增 `codexProviderCredentialKeys`（env_key、env_key_instructions、experimental_bearer_token、
  auth、gateway_oauth、aws、http_headers、env_http_headers、query_params），只更新时表里有任何一项就不接管，按原来的
  规矩另挑 `XingmangAI`、`XingmangAI-2`……，客户那张一个字不动；挑空名、认切官方留下的别名表、搬内置名下的老表也都跳过带凭据的。
  重置照旧沿用原名（模板整份重写，带不过去别家的设置）。
- 读回时正在用的表带着这几项，`matchesRelay` 判成 false：以前的版本已经接管过的那种（星芒地址 + 别家 env_key）
  首页不再显示「已配好」，改显示「不是当前账号的密钥」并给「改用当前账号」，点下去走上面那条就修好；
  换下架型号、刷型号菜单、补模板缺省项这些自动改写都不碰它（换线路只认来源记录，照旧只改地址）。
