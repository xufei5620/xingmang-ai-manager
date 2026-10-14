## 用户

- 历史账号的连接线路选「自动」时，改成先走默认线路，默认线路连不上才改走直连。之前升级到上一版后被自动切到直连的电脑，这次打开星芒会回到默认线路，工具配置也跟着改回来。线路手动固定过的不受影响。

## 开发

- `relay-sites.ts` 加 `relayAutoPreferredLines`、`relayAutoBackupLine`：「自动」先走哪条按站定。星芒账号（solov）照旧先走直连、备用默认线路；历史账号（solov-api）改成先走默认线路（api.solov.cc，CF）、备用直连（api-direct），yoyo 10-14「历史账号走的是 api 的 cf，直连备用」。0.2.17、0.2.18 是先走直连，和 docs/DIRECT-ROUTE-RELAY-SUPPLEMENT.md 第 5 节不一致。
- `relay-route-controller.ts`：`checkDirect` 改成 `checkPreferred`，`watch`、`checkRecovery`、`start` 都按站的先走线路办；连败三次、切回要连通 10 分钟、两次切换隔 5 分钟这些规矩不变。历史账号开机没有结论时照旧先走默认线路（未定下），第一次查通就定下并通知界面，工具配置跟着迁。`reportDirectFailure` 改名 `reportPreferredFailure`（`RelayLineRouter`、`DiagnosticsRelayRoute` 同改），只在走着先走那条时才查。星芒账号的全新安装两条一起查（`checkFirstLaunch`）不变。
- 0.2.18 留下的历史账号「直连」结论：最近一次切换不是「health-failed、改走直连」的一律当旧规矩存的，连同切换记录不认（`retireDirectFirstConclusions`）；星芒账号的结论原样用。落盘格式不变，装回 0.2.18 照样读得出。
- `relay-line-fetch.ts`：「自动」走着先走那条时没走通，改走备用那条重发；历史账号就是默认线路失败改走直连。白名单 404 只在直连上认，默认线路回的网页 404 原样交回。`createRelayObservedFetch` 对历史账号改报默认线路上的失败。
- `diagnostics.ts`「星芒 AI 网络」：先走那条没查通改查备用那条（`DiagnosticsRelayRoute.preferredLine`、`backupSite`，缺省按星芒账号）。历史账号退到直连时结论说「能连上星芒服务。默认线路这会儿连不上，已自动改走直连」。导出报告里的换线记录按记下的 from、to 说，新旧两种记录都说得对。
- 设置里历史账号线路的说明改成「自动会先走默认线路，默认线路连不上时改走直连。保存后重启星芒生效，不会切换账号。」
