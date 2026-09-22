## 用户

- 检查页「环境变量覆盖」这一项更准了：系统里设了会让工具连不上当前账号的变量（Claude Code 的 `ANTHROPIC_API_KEY`、`CLAUDE_CONFIG_DIR`，Gemini CLI 的 `GEMINI_API_KEY`、指向别处的 `GOOGLE_GEMINI_BASE_URL`），现在标成「待处理」，开机也会提醒；其余只可能有影响的变量仍是「需留意」。

## 开发

- `diagnostics.ts` 的 `ENVIRONMENT_OVERRIDE_VARIABLES` 每项加 `breaksAccount`，命中且不指向当前站点时 `PROVIDER_ENVIRONMENT_OVERRIDE` 报 `fail`。取值是在沙箱对 Claude Code 2.1.277、Codex 0.155.1、Gemini CLI 0.60.0 按 `config-files.ts` 模板写配置、指本地假接口逐个变量实测的：Claude 的 settings.json env 压过进程环境（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 盖不过），但 `ANTHROPIC_API_KEY` 多带的 `x-api-key` 在 new-api 的 /v1/messages 上顶掉 Authorization；Codex 自定义 provider 不认 `OPENAI_BASE_URL` / `OPENAI_API_KEY`，`.codex/.env` 里写这两个也不生效，`CODEX_HOME` 本程序同样认；Gemini 的 `~/.gemini/.env` 不覆盖进程环境。
