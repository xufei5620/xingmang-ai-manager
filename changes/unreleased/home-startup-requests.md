## 开发

- 首页开机少打 9 个请求（0.2.22 性能体检第 9、10 条，报告 `/mnt/project-files/0.2.22-性能体检.md`）。界面文字没改，首页余额、
  本月用量、「约还能用 N 天」、近 7 天七根柱子照旧都有。沙箱本地假接口、已登录冷启动各 3 次，开机 12 秒内打到星芒站的请求
  从 25~26 个降到 16~17 个。
- 近 7 天花费（`src/renderer-v2/features/tools/week-spend.ts`）：过完的那几天以前只记在内存里，每次开机都要 7 个 `/api/data/self`；
  现在按账号存进 localStorage（`xingmang-ui-v2:week-spend:<账号>`），开机只问今天，每天头一次开再多问一次昨天。读回来的一律校验，
  存不进去照旧每次问后台。过完的天要过了一小时才记（new-api 的看板数据默认 5 分钟才落一次库，零点刚过问到的昨天可能不全）。
  换账号时不再丢掉记着的天：按账号分开，不会串。
- 首页用量（`features/tools/api.ts` 的 `loadBalanceUsage`、`spendBaseline`）只用合计：`account:get-usage` 加可选的 `statsOnly`，
  星芒账号只打 `/api/log/self/stat`，不再陪着打一页明细 `/api/log/self`（服务端那一下还要数日志总条数）。
  历史账号不带这个字段（`sub2api-relay-backend.ts` 见到不认识的字段会整个拒掉），照旧。IPC 入参校验跟着加，false 不往下传。
- 余额（`electron/new-api-client.ts` 的 `getBalance`）：开机恢复登录刚读过 `/api/user/self`，10 秒内紧跟着的那一次余额直接用它，
  只给一次；之后的余额、换令牌、重新登录、换账号以后都照旧问服务器。
- 没动的：`/api/status` 仍是 3 个（两条线路各探一次，余额那一次本来就有 20 秒共用缓存；拿线路探测的回话喂给账号要把两个模块绑在一起，不值）；
  `/api/user/self/groups` 开机 2~3 次是签密钥那条路，不在这次范围。
