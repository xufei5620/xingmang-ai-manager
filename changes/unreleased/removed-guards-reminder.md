## 开发

- 新增「门禁删行提醒」（`.github/workflows/removed-guards.yml` + `scripts/report-removed-guards.cjs`）：PR 删掉或改掉门禁里的行（quality 工作流、`scripts/verify-*.test.cjs`、`trustedCommandEnvironment` 的禁用变量表、`ipc-channel-policy.ts`、密钥扫描、CODEOWNERS 等）、测试少了用例或断言、多了 `.skip` / `.only` / `.todo`、`npm test` 这几条命令少跑了东西时，在运行摘要页列出来并在 Files changed 里原处标警告。只提醒不拦，不进 `quality-gate`。
  用 `pull_request_target` 触发，名单和脚本从 main 读，PR 改不了自己的裁判；PR 的提交只当文字读、不执行，作业只读、不读 secret。先跑两周（到 2026-12-01）看误报再定要不要拦（验证方法建议第 5 条）。
