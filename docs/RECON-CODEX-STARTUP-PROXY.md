# Codex 启动代理与原生中文可行性

研究日期：2026-09-14。目标：星芒管理器在打开官方 Codex Desktop 时提供专属网络连接，尽可能只依赖官方中文资源与 `[desktop].localeOverride`，减少运行时汉化注入。

## 结论

可以实现仅供 Codex Desktop 使用的代理启动链路，无须修改系统代理或替换官方 app.asar。现有代码有 Windows MSIX 参数激活和 macOS bundle 启动入口，但没有内置节点/代理内核。

“代理可用 + 配置中文”仅在官方语言开关允许时成立；不能在缺少目标版本、登录模式和实际节点验证的情况下承诺彻底替代汉化注入。建议先实现可验证的纯原生启动模式，确认真实中文结果后关闭旧注入。

配置应放在实际 CODEX_HOME 的 `config.toml` 中：

```toml
[desktop]
localeOverride = "zh-CN"
```

已有 `[desktop]` 时只更新字段，沿用当前安全读写、备份和回读实现。

## 官方文档核对

本次先搜索官方 Codex 代理/语言说明并实际读取以下页面：

- https://learn.chatgpt.com/docs/config-file/config-reference （原 developers.openai.com 配置参考搜索结果重定向到此）
- https://learn.chatgpt.com/docs/config-file/environment-variables.md
- https://learn.chatgpt.com/docs/reference/settings.md
- https://learn.chatgpt.com/docs/reference/troubleshooting.md

这些页面没有建立“联网一次后永久中文”或“localeOverride 无条件打开翻译”的保证。配置参考中的 `features.network_proxy` 明确作用于沙箱命令网络，不能把它当作桌面前端/Statsig 的代理设置。下文的语言与请求机制来自本机安装包的只读检查，不宣称是公开稳定 API。

## 本机版本的语言机制

只读检查版本：Windows Codex **26.903.8094.0**，与之前客户的 **26.908.4834.0** 不同，后者须另行验证。

归档：`C:\Program Files\WindowsApps\OpenAI.Codex_26.903.8094.0_x64__2p2nqsd0c76g0\app\resources\app.asar`。

`webview\assets\app-initial-92cbfeba4f7c.js` 的 `rhs` 从动态配置 `72216192` 获取 `enable_i18n`（缺省 false）与 `locale_source`。`localeOverride` 优先于语言来源选择，但翻译资源加载与 IntlProvider messages 仍受 `enable_i18n` 控制。因此：

| 条件 | 预期结果 |
|---|---|
| 官方配置获取失败，无有效允许缓存 | 仅写中文偏好仍可能英文 |
| 官方开关为 true，偏好为 zh-CN，包有资源 | 可以使用原生中文 |
| 官方明确返回 false | 代理不会改变开关值 |

中文词条已经位于本地包，例如 `webview\assets\zh-CN-66f4921009e2.js`。代理解决的是官方配置初始化与刷新连接，不是重新下载整套翻译。

### 运行时汉化与调试端口的取舍（E-S3，2026-09-18）

前端 `enable_i18n` gate 只能在运行时绕过，所以 `--remote-debugging-port` 启动的 CDP 注入每次冷启动都要重来一次；而这个端口在 Codex 整个进程生命周期都开着，loopback 上没有认证（`--remote-allow-origins` 只约束带 Origin 头的握手）。因此**不能**把 `config.toml` 里的 `localeOverride = "zh-CN"` 当成用户同意开这个端口 —— 那个值是本程序自己写的默认值。

现在的规则：是否带调试端口启动，只看 `settings.json` 的 `codexDesktopChineseRuntimePatch`，由用户点「启用中文界面」时写入、点「跟随系统语言」时清除；缺省不带。`localeOverride` 仍会为新装自动写成 `zh-CN`，因为原生菜单链路不需要任何端口就能吃到它。

本机原生菜单链路不同：`.vite\build\main-C8LNyWut.js` 读取 `localeOverride` 后调用原生 Intl；`.vite\build\window-all-closed-BKkx4ypf.js` 从 `native-menu-locales/<locale>.json` 加载菜单，相关实现没有上述前端 gate，并监听偏好变化。因此这个版本的原生菜单可能仅靠偏好即可中文，仍需目标平台视觉验收。

## 网络范围与有效期

| 模式 | 观察到的初始化请求 |
|---|---|
| API Key / 未登录 | `POST https://ab.chatgpt.com/v1/initialize` |
| ChatGPT 登录 | `POST https://chatgpt.com/backend-api/wham/statsig/bootstrap` |
| ChatGPT bootstrap 失败回退 | 普通 Statsig 初始化 |

安装包渲染器 `mXo → oD.fetch → pkn → YX.httpFetch` 最终由主进程 `electron.net.fetch` 发送。因此 Chromium 进程代理参数是有针对性的实现入口。

Statsig 开启 `enableLiveValuesAutoRefresh`，SDK 缺省 600 秒刷新（服务端可覆盖）。初始化可能使用稳定 ID 对应的缓存，但仍尝试联网；`analytics.enabled=false` 分支还设置 `disableStorage=true`。不能用一次有缓存的成功启动证明全新用户、下一次启动或账号切换也能不联网。

HTTPS CONNECT / PAC 通常只能按主机选择路由，不能在不解密 TLS 的前提下保证仅代理同一主机上的某个 URL 路径。若选择 `chatgpt.com`，必须承认该主机其它流量也可能走节点。建议从实际初始化涉及的最小域名集合开始，保持星芒中转域名直连，避免直接全局通配。

## 离线实验

使用项目 Electron 依赖启动独立无窗口进程，`userData`/`sessionData` 指向 mkdtemp 目录，仅连接两个本地 HTTP 测试服务器。没有启动客户 Codex、读写登录状态或连接真实节点。

- 命令行指定 `--proxy-server=http://127.0.0.1:<port>`。
- 测试专用 `--proxy-bypass-list=<-loopback>`，使回环测试地址也参与代理；此项不建议直接带入产品。
- `electron.net.fetch` 由测试代理返回，Node 全局 `fetch` 则直接连接目标服务器。

脚本：`artifacts/codex-proxy/probe-run.mjs`、`probe-child.cjs`。结果：`artifacts/codex-proxy/network-stacks.json`。这验证了网络栈范围，**没有验证**真实上游 TLS/认证、MSIX 参数生效、中文显示或 Mac 原生行为。

## 建议实现

1. 点击“打开 Codex”时，主进程启动仅绑定 `127.0.0.1` 的网络辅助进程，等待端口就绪，再启动 Codex。远端可用 HTTPS CONNECT / SOCKS 节点；若输入 VLESS/VMess/Trojan 等配置，需对应跨平台协议内核、打包与更新，不能直接把分享链接传给 Chromium。
2. Windows 复用 `activateCodexDesktop(appId, arguments)`，单独构建代理启动参数；不再为了代理开启 CDP。Explorer AppsFolder 回退不保证参数送达，失败必须报告。
3. macOS 在验证过的 `.app` 启动计划中增加 `--args` 代理参数，保留已实现的 `CODEX_HOME` 与工作区深链；应在 Mac 实测 LaunchServices 参数传递。
4. 写入并回读中文偏好。先禁用当前运行时汉化注入，用官方初始化结果验证中文资源及实际界面/菜单。
5. 本地转发规则仅把所需官方主机转到上游，其它业务按既定直连策略处理；保持 TLS 端到端验证，不安装解密证书或修改官方回包。
6. 辅助进程与 Codex 生命周期绑定：关闭星芒但 Codex 仍在运行时不能立即断掉代理；Codex 全部相关进程退出后回收。已运行 Codex 仅唤起不会重新应用启动参数，需要保存工作后冷启动。
7. 面向客户的节点凭据由后台按账号下发、支持过期与轮换，主进程保管；不把同一份长期节点密码硬编码给所有安装包。出口流量/并发限制和节点健康状态属于服务运营的一部分。

当前星芒设置中的代理状态仅查询星芒自己的 Electron session；给这个 session 调 `setProxy()` 不会改变另一个应用 Codex 的网络。

## 进入产品前必须取得的结果

使用目标 Codex 版本、真实节点和隔离测试账号，在未打补丁的官方安装上验证：

- 全新用户数据且没有 Statsig 缓存：直连与代理分别冷启动对比。
- API Key 与 ChatGPT 登录分别确认真实开关值、中文资源加载和可见界面结果。
- 运行超过刷新周期、断网重连、关闭星芒而保留 Codex、Codex 重启和升级。
- Windows MSIX 与 macOS 各自确认参数生效和原生菜单。

当前没有为本方案指定真实节点，因此本次交付是可行性研究与离线网络实验；没有修改系统代理、用户 Codex 配置或现有汉化默认行为。
