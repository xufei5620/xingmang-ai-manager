## 用户

- 从星芒打开 Claude Desktop 时，会在后台自动连上网络加速，让它下得到第一次用（和每次自己升级以后）要下载的组件，不扣免费时长，Claude 关掉或连满一小时自动断开。以前国内网络下不到，聊天、Cowork 都报「Host Claude Code binary not available」或「Failed to start Claude's workspace」。

## 开发

- `acceleration-clash-config.ts` 的 `lineRoutedRules` 加 `DOMAIN,downloads.claude.ai,XINGMANG`（#1373）：Claude Desktop 3P 模式从这个主机下 Claude Code 程序（`claude-code-releases/<版本>/…`）和 Cowork 工作区（`vms/linux/<架构>/<编号>/rootfs.vhdx.zst` 等），国内直连超时。只加这一个主机，claude.ai、api.anthropic.com 照旧直连。洛杉矶服务器的放行名单同步加了这个域名。
- 新增 `claude-desktop-acceleration.ts`：从星芒打开 Claude Desktop 前照 Codex 桌面端那套替用户连上加速（`autoStartedBy: 'claude-desktop'`，不扣时长、看不见），Claude 退出或连满一小时断开；和 Codex 桌面端共用同一次会话时用 `heldElsewhere` / `holds` 交接，后用完的那边断开。`external-client-runtime.ts` 加 `onLaunched`，记下打开的那一份装在哪，供 `stillRunning` 判断它还在不在。
- Claude Desktop 配置弹窗两句提示改成请客户从星芒点「打开」（yoyo 2026-10-24 定的原文）。
