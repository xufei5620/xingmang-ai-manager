## 开发

- `electron/claude-desktop-model-topup.ts`、`electron/external-client-route-service.ts`：开机替 Claude Desktop 补型号（11-12「1 2 3 做」第 1 条那套）
  试到一半客户换了账号或退出登录，以前剩下的型号照样拿上一个账号的密钥一个个发过去试，只在最后写菜单那一步才发现账号变了
  （0.2.25 总单第 67 项，11-18 A03）；一个都没试通时还会替上一把密钥记一笔。`runClaudeDesktopModelTopUp` 加可选的
  `assertCurrent`，每试一个之前、试完记录之前各看一眼，路由服务传它自己的 `assertContext`（站点和账号都对得上才放行）。
  换了账号、退出了：已经发出去的那几个（最多同时 3 个）等它回来，没轮到的不再发，菜单和记录都不动，日志照旧是
  `top-up-failed`「账号已变化，这次不补型号」；切回原来那个账号，下次开机照常补。
