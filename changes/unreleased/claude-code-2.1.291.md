## 用户

- Claude Code 的推荐版本升到 2.1.291：修了回复被中途截断却显示已完成、同一个操作被执行两遍、断网时启动要等十几秒、退出时丢掉最后几条消息，以及有几种情况下每次提问都失败的问题。很长的对话照旧到老位置就自动压缩，不会撑到太长发不出去。

## 开发

- `electron/cli-verified-versions.ts` 把 Claude Code 的 `recommended` 从 2.1.277 抬到 2.1.291（npm latest，取代 #460 的 2.1.281）；2.1.278~2.1.291 上游 changelog 没有新的第三方端点回归，沙箱本地假接口对照 2.1.277 的请求体与工具列表一致，依据写进 `docs/CLI-VERIFIED-VERSIONS.md`。
- 2.1.285 起接自定义 `ANTHROPIC_BASE_URL` 时上下文按 1M 算（以前 200K），沙箱 `/context` 实测确认。`electron/config-files.ts` 接当前账号时在 `env` 写 `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` 压回 200K（模板、合并写入、启动补默认三处；用户写过的值不动，切回官方账号删掉），长对话照旧到 200K 附近就压缩。
