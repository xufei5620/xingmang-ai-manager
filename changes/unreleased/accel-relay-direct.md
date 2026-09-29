## 用户

- 开着游戏加速时，登录、查余额、准备密钥以及 Codex、Claude Code、Gemini、Grok 连当前账号的服务都直接连，不再绕到加速线路上。以前开了加速 Codex 反而变慢、其他工具却没变化的情况不会再有。检查页「星芒 AI 网络」一项在开着加速时也会注明这一点。

## 开发

- 第五批候选 4：`relay-sites.ts` 新增 `relayDirectHosts()`，从全部站点的 CLI 地址、账号地址、官网与取 Key 页取主机名；`acceleration-clash-config.ts` 的 `buildIsolatedMihomoConfig` 多收 `directHosts`（只收小写域名、最多 32 个），在 mihomo 规则 `MATCH,XINGMANG` 之前逐个加 `DOMAIN,<host>,DIRECT`，`acceleration-mihomo-runtime.ts` 启动内核时传入。解析器仍不依赖其他应用模块，打包脚本照旧单独加载它。Windows 与 macOS 共用这份内核配置，一处解决；系统代理例外列表不动，加速仍只接管系统代理、不开 TUN。取全部站点而不是当前账号的站点，是因为加速开着时切换账号不会重启内核。连通性验证（www.gstatic.com）仍走线路。
- `diagnostics.ts` 新增可选依赖 `inspectAccelerationActive`，`XINGMANG_NETWORK` 通过时若加速开着，结论加一句「开着加速时也直接连」，details 带 `route: 'direct'`；读不到加速状态按没开处理。`main.ts` 把原先 proxy-bypass 里判断加速状态的闭包提成 `accelerationRunning()`，两处共用。
