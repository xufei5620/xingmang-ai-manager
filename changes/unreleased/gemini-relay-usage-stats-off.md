## 用户

- 用当前账号跑 Gemini CLI 时，不再往外发使用统计，也不再带上本机的设备标识。

## 开发

- `electron/config-files.ts`：Gemini 星芒来源写 `privacy.usageStatisticsEnabled: false`（merge 只在用户没写过时补，切回 Google 账号时整张 `privacy` 恰好就是这一项才收回）。沙箱实测 0.60.0：开着时每次运行连一次 `play.googleapis.com`，且发给中转的每个请求都带 `x-gemini-api-privileged-user-id` 安装 ID 头；关掉后两样都没了。对应「接中转后的官方体验差距」G7。
