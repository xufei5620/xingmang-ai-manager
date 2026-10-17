## 用户

- Claude Code 的推荐版本升到 2.1.302：回复慢的时候不会过三分钟就被断开，当前账号的密钥也不会再顺带发给官方。

## 开发

- `electron/cli-verified-versions.ts` 把 Claude Code 的 `recommended` 从 2.1.296 抬到 2.1.302（npm latest，2.1.297、2.1.298 没发过）。上游 2.1.299 修了功能开关、启动、快速模式、账号资料、反馈几类发往 Anthropic 的请求带着第三方网关 Key，同版把自定义 `ANTHROPIC_BASE_URL` 下流式无数据的超时从 180 秒放到 300 秒；2.1.299~2.1.302 没有第三方端点回归。沙箱本地假接口对照 2.1.296 请求体字段、工具列表、鉴权头一致，依据写进 `docs/CLI-VERIFIED-VERSIONS.md`。
