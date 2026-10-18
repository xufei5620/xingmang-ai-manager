## 开发

- `relay-backend.ts`、`relay-sites.ts` 的过时注释改掉（#1140 第 3 条）：账号接口现在有两个实现，星芒账号走
  `new-api-client.ts`，历史账号走 `sub2api-relay-backend.ts`；「四个 CLI」改成按 `ProviderId` 说；开机恢复登录
  不再指向已经没人调用的 `restoreAccountSessionOnStartup`，改成 `realm-account-service.ts`。
- 删掉线路表 `RelayEndpoint` 里没人读的 `label` 字段（#1140 第 6 条），它的值还是「默认线路」「备用直连」旧叫法；
  界面上的线路名照旧来自 `registry/connection-routes.ts`，设置值和日志名不变。
