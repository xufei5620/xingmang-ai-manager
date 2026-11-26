## 开发

- 每周 CLI 巡检（2026-11-23）：推荐版本抬到 Claude Code 2.1.330、Codex 0.171.0、Grok 1.0.92（`electron/cli-verified-versions.ts`），
  三家都是当前 npm `latest`，Grok 同时是 xAI stable。区间内的变更记录逐条读过，没有网关回归；本地假接口上新旧两版对照重核，逐项相同。
  依据见 `docs/CLI-VERIFIED-VERSIONS.md`。
- 随包 Codex 型号名单的出处 tag 换成 `rust-v0.171.0`（`models.json` 与 `rust-v0.169.1` 逐字相同，sha256 不变）。
- 更新页的「## 用户」已满 60 条，这次不加新句；客户在工具版本旁看到的说明照旧来自各条的 `userNote`。
- `cli-relay-probe` 在 `solov` 上 Claude Code 2.1.330、Codex 0.171.0 都通过，两条 `verifiedSites` 填回 `['solov']`。
- `scripts/probe-cli-relay.cjs` 的「中转收不收结构化输出」也认 2.1.326 之后调试日志里的判定行（「Hooks: Prompt hook condition was met」等）：
  这些版本不再写钩子回答的原文，原来只认「Hooks: Model response:」，2.1.330 上就一直报「没测出」。
