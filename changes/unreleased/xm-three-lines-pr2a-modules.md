## 开发

- xm 三线路 PR-2a（C3、C4、C5、C6，新模块，主进程一行没接，行为不变）：`tool-path-probe.ts` 照 AI 工具自己的路子探一条星芒线路（系统解析全部地址、错开 250 毫秒并发连、SNI 用真域名、同一条连接上 `GET /api/status` 要 200 且 `success: true`，10 秒、16KB、不跟重定向、只认 relay-sites.ts 里星芒账号的两个 origin）；证书同时信 Node 自带和系统根证书（系统那份放在一次性的 worker 线程里读，不卡主进程），只靠系统根证书才过的标「安全软件接管」照样算通；「慢但有进展」不计失败。代理路径只给判法和候选代理（`probeToolPathThroughFetch`、`environmentProxyCandidates`），Electron 会话那半留给 PR-2b。
- `route-failure-classifier.ts`：失败打标签（正常 / 代理接管 / 未知 / 劫持），内置 Cloudflare 公布的地址段和 fake-ip、私网、回环等特殊段；读不到状态文件时一律「未知」，不判劫持。
- `route-status-file.ts`：读 `/xm-route-status.json`（v1），先当前应用线路再另一条，16KB、不跟重定向、`legit_ips` 逐项校验是 IP 字面量，缓存 10 分钟（读不到也缓存），准备降级时不走缓存重读。服务端还没上线，读不到只禁止新分配香港。
- `tool-route-controller.ts`：工具线路状态机。L1 → L2（占位，第一批恒不可选、不进 RelayEndpointId）→ L3；连续 3 轮失败（隔 15 秒）或劫持 1 次准备降级，服务端 incident 时从第一次失败起等 5 分钟、只切 CF；挑这一轮通过的最高线路（可往上回）；两次切换隔 5 分钟；冷却期 0 / 1 / 6 / 24 小时按墙钟、跨重启；冷却期满每 2 分钟查、连续 6 次通才回；7 天无失败的开机 30 秒内 3 次通就回；退出不回升；L1/L2 按解析地址去重；三线全挂不改配置只出提示（按原因 24 小时一次），劫持提示 7 天一次。状态另存 `tool-route-state.json`（safe-local-data，8KB，只存线路 id、原因和时间，失败记录最多 16 条），不碰 0.2.17 要读的 `relay-route-lines.json`；升级首启取那份文件里星芒账号的结论，7 天内 `health-failed` 给洛杉矶记一次失败。
- quality 工作流的 Windows、macOS 跑道各加一步 `e2e/system-ca-smoke.mjs`：现场生成一次性测试根装进跑道机器的系统证书库，要求 Electron 主进程（含 worker 线程）读得到、只信自带根证书时握手失败、加上系统根证书后握手通过，用完删掉。
