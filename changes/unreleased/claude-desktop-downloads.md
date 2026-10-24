## 用户

- 开着网络加速时，Claude Desktop 第一次用要下载的组件也走加速线路。以前国内网络下不到，聊天、Cowork 都报「Host Claude Code binary not available」或「Failed to start Claude's workspace」。

## 开发

- `acceleration-clash-config.ts` 的 `lineRoutedRules` 加 `DOMAIN,downloads.claude.ai,XINGMANG`（#1373）：Claude Desktop 3P 模式从这个主机下 Claude Code 程序（`claude-code-releases/<版本>/…`）和 Cowork 工作区（`vms/linux/<架构>/<编号>/rootfs.vhdx.zst` 等），国内直连超时。只加这一个主机，claude.ai、api.anthropic.com 照旧直连。洛杉矶服务器的放行名单同步加了这个域名。
