## 用户

- 首页工具行「…」里新增「切到当前账号」「切回官方账号」：点一下就自动备份原来的配置、把会冲突的旧登录挪到一边、写好新配置并测一次能不能连上，连不上会自动恢复原样并说明原因。
- 以前用 Anthropic Console 登录过 Claude Code 的电脑，切到当前账号后不再报「401 Invalid token」。
- 在 Codex 里点过「用 ChatGPT 登录」、但配置还指着当前账号时，首页不再误显示成「官方账号」，改为提示配置被改过，可一键修复或切回官方。
- 切回官方账号时，如果这台电脑还没登录过官方账号，会直接告诉你在工具里怎么登录。
- 教程新增一章「官方账号和当前账号怎么切换？」。

## 开发

- 新增 `electron/account-source-switch.ts`（纯编排，依赖全注入）与通道 `config:switch-account-source`：`backups.ts` 的 `pre-save` 备份 → 写入 → `runConnectionCheck` → `unconfigured/config/credential/group/model/protocol` 失败时恢复备份、放回挪开的凭据、还原 `officialProviders`；网络、额度、未知只提示不回滚。
- Claude Code 2.1.277 会把 `~/.claude.json` 的 `primaryApiKey` 以 `x-api-key` 与 `ANTHROPIC_AUTH_TOKEN` 同时发出，new-api rc.24 在 `/v1/messages` 上用 `x-api-key` 覆盖 `Authorization`（`middleware/auth.go` 370–375 行）。`saveConfig` 写 Claude 后把它挪进 `~/.claude/xingmang-claude-console-key.json`，`switchToOfficialAccount` 放回（`config-files.ts` 的 `moveClaudeConsoleKeyAside` / `restoreClaudeConsoleKey`，走 `executeFilePlans`）。
- Codex：当前账号那份 `config.toml` 把 `cli_auth_credentials_store` 的 `keyring`/`auto` 固定成 `file`（凭据库优先于 auth.json）；`readCodexAuthMode` 对没写 `auth_mode` 的混合 auth.json 改判 `apikey`，与 Codex 0.155.1 `resolved_mode()` 一致；渲染层 `sourceFor` 把「ChatGPT 令牌 + config.toml 仍指向当前账号服务」判为 `changed`，原先判 `official`。
- 新增 `inspectOfficialLogin`，只看文件与字段是否存在，不读令牌；Codex 用系统凭据库时返回 null（看不出来）。
- 一键切回官方只给 Claude Code 与 Codex：Gemini 个人账号已不能登录，Grok 暂未做官方来源。
- 调研结论（13 种切换报错情形、报错原文与源码出处）见项目文件「官方账号与中转账号切换-报错情形-2026-09-22.md」。
