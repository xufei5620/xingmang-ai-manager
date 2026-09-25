## 用户

- 电脑里以前开过的代理（加速）软件关掉或崩了、系统代理还指着它时，星芒会自己改为直接联网，账号、余额、聊天和装工具照常能用；顶部说明一句，并给「打开系统代理设置」「知道了」两个按钮。只改星芒自己，电脑的设置不动；下次打开软件照旧跟着系统走。
- 直接联网也不通时，顶部改说「电脑里设置的代理连不上……请重新打开你的代理（加速）软件，或者把系统代理关掉」，旁边有「打开系统代理设置」。
- 校园网、酒店、公共 Wi-Fi 要先网页登录时，顶部改说「这个网络要先登录认证」，并有「打开认证页」按钮，登录后自动恢复。
- 设置 →「网络连接」在自动改为直接联网时写明「电脑里的代理连不上，本次已自动绕开」。

## 开发

- 新增 `electron/proxy-bypass.ts`：`createProxyBypass` 在余额连续两次报代理类失败后，由渲染层调 `network:bypass-broken-proxy` 触发；当前确实走代理、星芒加速没开（读不到加速状态按开着处理）时把 `session.defaultSession` 改成 `direct`，用 `/api/status`（`relayStatusProbeUrl`）探一次：不跟重定向、不读正文、8 秒超时，服务回了话就本次运行保持直连，否则改回 `system`。不落盘。
- 新增 `network:open-settings`（`proxy` / `captive-portal`）：地址写死在主进程（Windows `ms-settings:network-proxy`、`http://www.msftconnecttest.com/redirect`；Mac 网络设置、`http://captive.apple.com/`），渲染层不传网址。
- `balance-store.ts` 快照多存 `networkFailureReason`；`online-status.ts` 新增 `offlineCause` / `offlineBannerTexts` / `proxyBypassedBannerText`；`OfflineBanner` 按原因分三种说法。
- 平台服务 `describeSessionProxy`：经 `platform/proxy-bypass-bridge.ts` 读直连状态，给「网络连接」一行补原因。
