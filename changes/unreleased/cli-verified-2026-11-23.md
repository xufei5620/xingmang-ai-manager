## 开发

- 每周 CLI 巡检（2026-11-23）：推荐版本抬到 Claude Code 2.1.330、Codex 0.171.0、Grok 1.0.92（`electron/cli-verified-versions.ts`），
  三家都是当前 npm `latest`，Grok 同时是 xAI stable。区间内的变更记录逐条读过，没有网关回归；本地假接口上新旧两版对照重核，逐项相同。
  依据见 `docs/CLI-VERIFIED-VERSIONS.md`。
- 随包 Codex 型号名单的出处 tag 换成 `rust-v0.171.0`（`models.json` 与 `rust-v0.169.1` 逐字相同，sha256 不变）。
- 更新页的「## 用户」已满 60 条，这次不加新句；客户在工具版本旁看到的说明照旧来自各条的 `userNote`。
