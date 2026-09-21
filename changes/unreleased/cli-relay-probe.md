## 开发

- CI 加 `cli-relay-probe` 作业（`scripts/probe-cli-relay.cjs`）：PR 改到
  `electron/cli-verified-versions.ts` 或 `docs/CLI-VERIFIED-VERSIONS.md` 时，装上名单钉住的那个
  Claude Code 版本，对 `relay-sites.ts` 里每个中转站点各跑一次 `claude -p` 最小请求，结论写进
  job summary。名单挡住的两次上游回归都是 CLI 自己发出的请求被第三方端点拒掉，`curl` 手搓的请求
  验证不了这一类，只能跑真的 CLI。探测密钥走仓库 secret `XINGMANG_CLI_PATROL_KEY`，只通过子进程
  环境变量交给 CLI、不进 argv，输出统一脱敏；secret 不存在时作业照常通过，但 summary 里写明
  「未在中转实测」。只有「400 类拒绝」判定版本不可用，401/403 与额度、5xx 分类报成探测自身故障。
  `scripts/ci-change-scope.cjs` 新增 `cliVersions` 输出驱动这个作业，`quality-gate` 接受它
  skipped、拒绝它变红。配套加 `scripts/probe-cli-relay.test.cjs`，并接进 `npm run test:scripts`。
- 同时建了每周一 01:00 UTC 的巡检例程：比对 npm latest 与名单，有新版就读上游 changelog 找网关
  相关回归，没回归开草稿 PR 抬版本、有回归改为加 `blocked`，一律不自动合并。运行方式与判定口径写进
  `docs/CLI-VERIFIED-VERSIONS.md`。
