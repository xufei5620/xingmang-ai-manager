## 用户

- 检查页多了两项，连不上时更好找原因：「查网址的服务（DNS）」看这台电脑有没有把星芒的地址查错，查错了照着写好的步骤改，
  点「打开网络设置」直接过去；「别的代理软件」看开着的代理软件有没有挡住星芒，挡住了会说清哪些工具受影响，
  点「打开系统代理设置」就能去关。

## 开发

- 检查页加 `RELAY_DNS`（`diagnostics-dns-check.ts`）：用电脑自己的 DNS（`dns.lookup`）和 223.5.5.5、119.29.29.29
  （`dns.Resolver`，每台 1.4 秒、整项 3 秒）各查一遍工具线路两条主机名。线路1 合法 = CF 段；星芒账号线路2 合法 =
  上次读到的线路状态文件 `legitIps`，没有就只和公共 DNS 对。fake-ip、私网段算代理软件接管，不判；只有电脑给的不合法、
  公共 DNS 给的合法又不一样时才说查错。两条都错红灯，只错一条看线路设置：「自动」或固定在对的那条是绿灯，
  固定在错的那条黄灯并带 `reroute: 'auto'`，「去处理」翻到设置里线路那一行。日志只记每条线路的结论，不记地址。
- 检查页加 `SYSTEM_PROXY_SOFTWARE`（`diagnostics-proxy-software-check.ts`）：问只跟随系统代理的那个会话
  （`network-routes.ts` 的 `resolveSystemProxy` / `systemProxyFetch`，另用 `siteDirectFetch` 直连对照）连
  `/api/status`。本机端口不通或报代理错 = 代理软件没开；经代理不通、直连通才说它挡路；两边都不通不怪代理。
  星芒加速自己设的代理不查。黄灯带 `fix: 'open-proxy-settings'`（只有 Windows、Mac）。
- `PROXY_ENVIRONMENT` 只管另外设的代理（环境变量、npm 等），系统代理那半句挪到上面那一项；删掉
  `inspectAppProxyRoute` / `withAppProxyRoute` 和依赖 `resolveAppProxy` / `siteDirectActive`：它们问的是默认会话，
  星芒绕开坏代理改直连以后答 DIRECT，会把没在运行的代理说成没开。Windows 没设代理时那句改成「没有另外设过代理」。
- `network:open-settings` 加 `dns`：Windows 打开 `ms-settings:network-status`，Mac 打开网络设置，地址照旧写死在主进程。
  检查页那两行的按钮由主进程在 details 里放 `fix` 决定（`features/app/network-settings-fix.ts`），Linux 不给。
