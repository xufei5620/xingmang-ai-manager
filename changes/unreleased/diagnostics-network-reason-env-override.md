## 用户

- 检查页的「星芒 AI 网络」失败时会说清原因：域名解析不出来、连接被切断、超时、证书被替换（公司网关常见），还是被登录门户拦到了别的页面（酒店、校园网常见），每种都带一句该怎么办；网络其实通了、只是服务端返回了错误码时也不再笼统地说「检查时发生错误」。
- 检查页新增「环境变量覆盖」一项：系统里如果设了 `ANTHROPIC_BASE_URL`、`OPENAI_API_KEY`、`GEMINI_API_KEY` 这类变量，自己开终端跑命令行工具时可能会盖过当前账号写入的配置，这一项会把变量名列出来提醒（只提醒不改动，变量的值不会显示，也不会写进导出的诊断文件）。

## 开发

- `network-failure.ts`：`failurePatterns` 补一条 `intercepted`（`unexpected redirect` / `ERR_UNSAFE_REDIRECT` / `ERR_TOO_MANY_REDIRECTS`）。`redirect: 'error'` 下 undici 把 3xx 变成 `TypeError: fetch failed`，真正的原因只在 cause 的 `unexpected redirect` 里，此前这类失败一条都归不出来。
- `diagnostics.ts` 的 `XINGMANG_NETWORK`：自己 try/catch，用 `classifyNetworkFailure` 归类后返回 `state: 'fail'` + `networkFailureMessages[reason]`，`details` 只留 `{ endpoint, reason }`；HEAD 成功但 `content-type` 是 `text/html` 也判 `intercepted`；非 2xx 从「检查时发生错误」改为 `fail` 加一句说明网络通、问题在服务端；归不出类的异常仍走 `runIsolatedCheck` 的兜底。不新增网络请求。
- `DiagnosticsDependencies` 新增可选 `log`，由 `main.ts` 接到 `runtimeLog`（source `diagnostics`）。上游英文原文（`errorChainText` 展开 cause 链）只进 `runtime.jsonl`，不进会上屏也会被导出的报告（I3、I13）。
- `diagnostics.ts` 新增检查项 `PROVIDER_ENVIRONMENT_OVERRIDE`（标题「环境变量覆盖」，与 `PROXY_ENVIRONMENT` 并排）：只读注入的 `env`，大小写不敏感地扫 Claude / Codex / Gemini 的 12 个变量，有值报 `warn`，报告里只放变量名。`*_BASE_URL` 指向当前站点时降级为 `pass` 并注明「已指向当前账号」；`CODEX_HOME` 指到 `~/.codex` 默认位置时直接跳过——它是 `codex-home.ts` 自己注入进 `codexEnv` 的，不跳过会每次都给一条假警报。Grok 的同类变量本仓没实测过，按 T12 先不列。
- `pages-maintenance.tsx` 的 `diagnosticTarget` 加 `code.includes('ENVIRONMENT')`：新项虽然以 `PROVIDER_` 开头，「去处理」要落到设置页而不是首页。
