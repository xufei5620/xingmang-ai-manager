## 用户

- Claude Code 的推荐版本升到 2.1.281：修了回复被中途截断却显示已完成、同一个操作被执行两遍、断网时启动要等十几秒这几处问题。

## 开发

- `electron/cli-verified-versions.ts` 把 Claude Code 的 `recommended` 从 2.1.277 抬到 2.1.281（npm latest）；2.1.278~2.1.281 上游 changelog 没有新的第三方端点回归，沙箱本地假接口对照 2.1.277 的请求体与工具列表一致，依据写进 `docs/CLI-VERIFIED-VERSIONS.md`。
