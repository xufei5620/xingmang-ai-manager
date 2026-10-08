## 用户

- 星芒账号的 AI 工具（Claude Code、Codex、Gemini、Grok 等）会自己挑能连上的线路：洛杉矶连不上就换 CF，洛杉矶恢复稳定后再换回来；判断时照 AI 工具自己的连法测，开着系统代理或设了代理环境变量的电脑也算在内。管理工具自己用哪条线路照旧，两边分开定。
- 服务端正在切换线路时，首页会安静地显示一行「服务端正在切换线路，稍等几分钟」。
- 所有线路都连不上时，首页会说清楚是网络掐断、安全软件接管还是查不到地址，并给一个「重新检测」按钮；配置不会被乱改。
- 你所在的网络把洛杉矶线路的地址指到别处时，星芒会改用 CF 线路并在首页说一句；星芒不会改你电脑的任何设置。

## 开发

- xm 三线路 PR-2b（把 PR-2a 的模块接进主进程）：主进程起一个只管星芒账号（solov）的工具线路控制器（`tool-route-controller.ts`，状态存 `tool-route-state.json`，升级首启读 `relay-route-lines.json` 的旧结论），由它决定写进 AI 工具配置的线路；原来的应用线路控制器（`relay-route-controller.ts`）照旧管管理工具自己的流量、历史账号（solov-api）和更新源，日志分别带 `kind: 'app'` / `kind: 'tool'`。
- `createToolRouteRoutingSnapshot`：工具相关的路由快照里 solov 取工具线路（恒为已定），solov-api 取应用线路，solov-api 的线路逻辑一行未改。诊断、工具自检、Codex 探测、修复清环境变量、反馈环境描述改用工具线路；反馈上报线路、更新源、启动必需检查仍用应用线路。
- `tool-route-probe.ts`：一条线路要在无代理、系统代理（对该 origin 生效时，经 `xingmang-tool-proxy-*` 会话）、每个 HTTPS_PROXY / ALL_PROXY 上都通才算通；没有一条线路全通时以无代理路径为准。带用户名密码的代理不测（`environmentProxyCandidates` 跳过）。Linux 只测无代理路径。环境变量代理只在启动、唤醒、网络恢复、手动重新检测和准备降级时重读。
- 已观察的请求（`createRelayObservedFetch`）对星芒账号只在自动模式、且请求打到工具当前线路时把失败报给工具线路控制器（`check:<原因>`），手动固定线路和历史账号照旧。
- `tool-route-status.ts`：把控制器的快照与提示整理成设置快照里的只读字段 `relayToolRouteStatus`（服务端切换中 / 三线全挂及原因与管理工具能否连上 / 劫持，劫持提示留半小时），另加只读 `relayToolRouteLines`；不落盘、不加 IPC 通道，复用 `network:relay-route-changed` 让界面重读。
- `system:scan` 的选项新增 `recheckRoutes`，首页「重新检测」带上它让工具线路控制器手动重测一轮；唤醒和网络恢复（15 秒查一次 `net.isOnline()`）也各触发一轮。
- 开发时 `XINGMANG_TOOL_ROUTE_FAST=1`（仅未打包）把工具线路的时钟加快 60 倍，方便看降级与回升。
