## 用户

- 导出反馈报告、复制日志时，Gemini 和 Grok 的密钥现在也会自动打码，和原来的星芒密钥一样不会被发出去。

## 开发

- 新增零依赖的 `electron/redaction-patterns.ts`，`command-runner.ts`、`startup-log.ts`、`diagnostics.ts` 三份几乎相同的打码规则收口到这一张表；`crash-report.ts` 与 `updater.ts` 也改用同一套形状规则。只加不删：补上 `AIza…`（Google）、`xai-…`（Grok，20 位起步，避开 `@xai-official/grok` 包名）、查询参数 `key=`，`x-api-key` / `x-goog-api-key` 请求头由原有 `api[_-]?key` 规则覆盖并加测试钉住；`sk-` 在各处统一为大小写不敏感（原先只有诊断是）。
- `runtime-log.ts` 按字段名打码新增「名字恰好是 `key`」一项，`keyboard`、`cacheKey` 这类不受影响。
- 第十批候选 9（B）。
