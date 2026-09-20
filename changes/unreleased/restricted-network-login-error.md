## 用户

- 在校园网、公司网这类受限网络里登录失败时，不再只说「登录没有成功，请稍后重试」：现在会分别说明是解析不出
  服务器地址、连接被切断、当前网络替换了安全证书，还是需要先在浏览器完成上网认证，并提示换一个网络（例如手机
  热点）再试，失败原因同时记进日志便于客服排查。

## 开发

- 新增 `electron/network-failure.ts`：把 Chromium `net::ERR_*` 与 Node errno（含 `fetch` 的 cause 链）归到
  offline / dns / tls / proxy / refused / timeout / intercepted 七类，并给出唯一一份中文文案。模块零依赖，
  已加入 `scripts/verify-renderer-boundary.test.cjs` 的 `valueImportable`，渲染层直接复用同一份文案，两棵树
  不再各写一句。
- `new-api-client.ts` 的 `performRequest` 改抛 `NewApiNetworkError`（带 reason）：超时、传输失败按分类抛；
  跨源重定向、3xx 重定向与「HTTP 2xx 但不是 JSON」一律归为 intercepted——这三种正是门户认证页的形态。
- `sub2api-account-client.ts` 的传输失败把原始错误交给 `RealmAccountError`，归得出网络原因时替换兜底文案；
  HTTP 失败仍用原文案。
- `ipc.ts` 的失败日志新增 `networkFailure` 字段（归不出来时不写），runtime.jsonl 里可直接看出是哪一类。
- `src/renderer-v2/features/auth/state.ts` 的 `authErrorMessage` 在启发式之前先认这句话，避免宽正则把
  「证书被替换」说成「连接超时」。
