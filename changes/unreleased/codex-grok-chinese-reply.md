## 开发

- Codex 和 Grok 现在也默认用中文回答，跟 Claude 一样；你自己给它们定过回答规矩的，星芒不动。（给客户看的这句等批了再挪进「用户」。）
- `electron/config-files.ts`：写当前账号的 Codex、Grok 配置时，配置目录（`~/.codex`、`~/.grok`）里一份全局说明都没有，就在同一次两阶段提交里放一份 `AGENTS.md`（`MANAGED_GLOBAL_RESPONSE_LANGUAGE_INSTRUCTIONS`：始终用简体中文回复，代码、命令、路径、报错原文不翻译）。Codex 认 `AGENTS.override.md` 和 `AGENTS.md`（10-23 源码 `codex-rs/codex-home/src/instructions/mod.rs`），Grok 1.0.70 自带说明里 `~/.grok/AGENTS.md` 是全局规则、同目录 `AGENT.md` / `CLAUDE.md` / `CLAUDE.local.md` 也认；这几个名字有任何一个（大小写不论，链接也算）就一个字不碰。照 Claude Code `language: 简体中文` 的做法：老客户开机按模板第 6 版（`relayTemplateRevision` 5 → 6，第 5 版是同批的 VS Code 免登录）补一次，切回官方账号不收回。发出去的这一版摘要记在 `PUBLISHED_GLOBAL_RESPONSE_LANGUAGE_DIGESTS`，以后认得出是不是星芒放的。
