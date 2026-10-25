## 用户

- 新增「手机遥控 Codex」（设置 › 工具管理）：在飞书里私聊你自己建的机器人，就能让这台电脑上的 Codex 干活，
  用的是星芒的线路和额度。只认配对过的那一个人，Codex 要跑命令都先在聊天里问你，回「同意」才动手；
  关掉星芒或闲着 4 小时自动断开。

## 开发

- 手机遥控 Codex 的底座和飞书渠道：`codex-remote-service.ts` 管配对（6 位码 10 分钟、错 20 次作废）、只认绑定那个人的私聊、
  一次一轮、审批转到聊天（10 分钟没回自动拒绝）、回话脱敏（I13）、闲置 4 小时断开；Codex 用客户装好的命令行工具起
  `codex app-server`（stdio，argv 不经 shell，I1），开对话固定 `approvalPolicy: untrusted` + `sandbox: workspace-write`，
  不给完全权限、不自动同意。飞书走开放平台长连接（帧格式照官方 SDK 逐字节对过），请求一律经 `codex-remote-http.ts`（I10）。
- Windows 上星芒以管理员身份或高完整性运行时不许开遥控；「打开遥控」开关不落盘，开机自启的星芒不会无人值守地连上。
  渠道凭据 `safeStorage` 加密，存飞书凭据那条通道记为密钥入参（I3）。
- 设置页新卡 `features/settings/codex-remote/`，渠道那一块按 `channel-sections.tsx` 登记，微信渠道接进来时只加一项。
