## 用户

- 已登录星芒账号时，检查页「星芒 AI 网络」因为连接被切断、解析不出地址或一直等不到回话而变红，这一行多一个「去处理」：
  点了直接翻到「设置 → 网络」里的「星芒账号线路」，可以换成「备用直连」，点「现在重开」后生效。历史账号和别的原因（没网、代理、
  证书等）照旧只给结论。
- 检查页「星芒 AI 网络」一直等不到回话时，结论不再是「检查超时」，改成「连接账号服务超时，请检查网络后再试。」

## 开发

- 第四十三批 B（10-6 拍板清单第 9 条，照推荐做）：检查页「星芒 AI 网络」的「去处理」是新手引导梳理 9-25 第 2 条拿掉的，理由是
  「设置 → 网络」里没有能处理它的东西；#872 以后那一组最上面就是「星芒账号线路」。`diagnosticTarget` 对 `XINGMANG_NETWORK`
  只在 `details.reason` 是 `dns` / `refused` / `timeout`、`details.siteId` 就是登着的那个账号的站、这个站不止一条线路时回
  `settings`；新的 `diagnosticSection` 给出那一行（`relay-route-solov`），外壳现成的「是一行就打开它那一组再翻过去」接着做。
  代理软件那一项（`CLASH_VERGE_TUN`）照旧不给。不加字。
- 「登着」用新的 `signedInSiteId`（`account-context.ts`）：已登录的看会话；开机恢复没结束或联不上搁着的（登录还在）看正在恢复的
  那个账号，线路被切断时开机恢复多半也联不上；访客不给。开机恢复历史账号时会话的 `siteId` 和主进程查的站都还是默认那个，靠这一条
  才不会把历史账号带去星芒账号的线路。`HealthPage` 从 `BusinessPage` 收 `accountSession`，缺省按访客算（旧行为）。
- `diagnostics.ts`：这一项归类出网络原因时 details 多带 `siteId`（「查看详情」不摆这个键，导出报告里本来就有地址）；加
  `timeoutOutcome`，8 秒等不到回话从 `error`「检查超时」改成 `fail` + `networkFailureMessages.timeout`，带 `reason: 'timeout'`
  和 `siteId`。连带一处现成行为：同一次检查里「安全证书」判成「电脑自己也不认」时，超时这种也改说「先看上面「星芒 AI 网络」那一项」
  （`reconcileCertificateTrustWithNetwork` 认的是 `fail`），和别的连不上一样。
- 测试：`diagnostics.test.ts` 两条（默认线路、备用直连、历史账号三种站失败时都带对 `siteId`；探测一直不回是 `fail` 加超时那句）；
  `business.test.ts` 两条（三种原因翻到 `relay-route-solov`；别的原因、HTTP 状态、历史账号、访客、查的不是登着的这个站、不带站点
  都不给）；`account-context.test.ts` 一条；`testing/app-check.mjs` 三条浏览器回归（登着星芒账号点「去处理」到设置「网络」、
  那一行亮且选择框拿到焦点、选「备用直连」出「现在重开」；开机恢复中照样给；历史账号和没登录进首页的都不给）。
