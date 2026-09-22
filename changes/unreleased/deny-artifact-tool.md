## 用户

- 用星芒账号配置 Claude Code 时，不再把「发布成 claude.ai 链接」这个用不上的工具交给中转，
  少掉一类「每轮请求都失败」的故障；切回官方 Claude 账号时这个工具会自动恢复。

## 开发

- 候选 9：`electron/config-files.ts` 的 claude 分支在 `permissions` 里写 `deny: ['Artifact']`。
  `createPlans`（reset）直接写进模板；`createMergePlans`（merge）追加进已有 `deny` 数组、
  已有则不重复，用户自己写的 `deny` 项与 `permissions` 下其他键原样保留；
  `createOfficialAccountPlans`（切官方账号）只摘掉 `Artifact` 这一项，其余不动，
  `deny` 变空则连键一起删。
- 动机是 2.1.265~2.1.268 那次「第三方 Anthropic 兼容端点每轮请求 400」——上游 2.1.268 的
  修复原文说载体正是 Artifact 工具输入 schema 里的一段正则。这条 deny 是
  `electron/cli-verified-versions.ts` 版本名单之外的第二道保险。
- 验证方法（沙箱、claude-code 2.1.277、空 HOME、本地 HTTP 假接口抓请求体）：
  `permissions.deny` 不是只拦执行，而是把工具定义整条从请求体 `tools` 里摘掉——
  基线 25 个工具，`deny: ['Artifact', 'WebFetch', 'NotebookEdit']` 后剩 23 个，
  `WebFetch` 与 `NotebookEdit` 都不见了；`defaultMode: 'bypassPermissions'` 下同样生效，
  设置放 `~/.claude/settings.json` 有效。同一次抓包里 2.1.277 指向第三方端点时本来就
  没有发 `Artifact`（上游已按凭据来源把它挡掉），所以这条目前是保险而非现行修复。
