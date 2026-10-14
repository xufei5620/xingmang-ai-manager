## 开发

- Gemini CLI 下线（yoyo 2026-10-14）：界面不显示、不再装、不再签 Key、不再改它的配置，老客户电脑上的不卸不删。
  `catalog.ts` 加退役名单 `retiredProviderIds` 与 `activeProviderIds` / `isActiveProviderId`，`gemini` 仍留在
  `ProviderId` 里：本机 Key 缓存、备份清单、卸载时收回钩子都按它认老数据，拿掉会把这些一起弄坏。
- 主进程「替每个工具做点什么」的地方改走 `activeProviderIds`：扫描（快照里 Gemini 是 `retired: true` 的占位，不起进程、
  不查 npm）、签 Key（new-api 与 Sub2API 都不再签，历史账号没有 Gemini 分组也不再报失败）、跟线路、补设置、开机修钩子、
  工具额度与用量、检查页各项（Gemini 的五个环境变量、个人文件夹信任、`CLI_GEMINI` / `PROVIDER_GEMINI` 都不再出）、
  反馈报告、扩展列表、对话记录列表、托盘、Linux 启动器。IPC 动作通道收到 `gemini` 一律按原有的「未知的 CLI 类型」等文案拒绝；
  备份页不再列 Gemini 的旧备份，也不让恢复（文件留在磁盘上）。读老数据、脱敏、卸载收回的地方照旧认四家。
- 新界面（`src/renderer-v2/`）：注册表去掉 Gemini，首页、新手引导（连同只为它存在的 Python 那一步）、扩展、记录、备份、
  账号页工具额度与用量、Ctrl/⌘ + 数字快捷键都只剩三家；主进程数据里带着 `gemini` 也一概不认，密钥页不再给它的 Key 标「在用」。
  `check:v2` 的 testId 对照逐条放行冻结旧界面里的 `guide-route-gemini`，新界面再出现它反而报错。
- 开机后在后台收回星芒以前写进 `~/.gemini/settings.json` 的做完提醒（`xingmang-notify` 钩子）和星芒画图
  （`mcpServers.xingmang-image`），Key、线路、型号不动：`config-files.ts` 的 `inspectRetiredGeminiIntegrations` /
  `removeRetiredGeminiIntegrations`（留 `.bak`，配置读不懂就不动），`system-service.ts` 的
  `reclaimRetiredToolIntegrations`（Gemini 开着或看不出开没开就等下次开机）。登录时不再往 Gemini 里登记画图工具。
- 拿掉只为 Gemini 存在的「让这台电脑上所有终端都信任证书」：删 `user-certificate-trust.ts` 与
  `diagnostics:trust-certificates-user-wide` 通道，检查页「安全证书」只剩一句结论。已经设好的那一项不收回。
- 中转实测（`scripts/probe-cli-relay.cjs`）与每周巡检不再管 Gemini；`cli-verified-versions.ts` 里它那条只为覆盖全部
  `ProviderId` 留着，不再抬。
