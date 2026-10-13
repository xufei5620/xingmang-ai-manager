## 用户

- Claude Code、Codex、Grok CLI 的推荐版本分别升到 2.1.296、0.162.1、1.0.52：修了用大上下文型号时可能每次提问都失败、Windows 10 上读不到某些盘里的文件、服务繁忙时太早放弃的问题。

## 开发

- `electron/cli-verified-versions.ts` 三家 `recommended` 一起抬（10-12 每周巡检，yoyo 测完 0.2.18 后补做）：Claude Code 2.1.291 → 2.1.296、Codex 0.160.1 → 0.162.1、Grok 1.0.46 → 1.0.52（npm latest 且是 xAI stable）。Gemini 留在 0.62.0（2026-10-13 yoyo 说「Gemini CLI 不要了」）。区间内上游变更记录没有第三方端点回归，三家都在沙箱本地假接口重核过，依据写进 `docs/CLI-VERIFIED-VERSIONS.md`。
- Claude Code 2.1.293 起 `haiku` 别名在自定义 `ANTHROPIC_BASE_URL` 下改发 `claude-haiku-5-5`（以前 `claude-haiku-4-5-20251001`），内置 `claude-code-guide` 帮手与 `/model haiku` 要中转开着这个型号，缺了不会退回 4.5；后台小请求仍用主型号。
- 随包 Codex 型号名单（`bundled-catalog/codex-models/models.json`）换成 `rust-v0.162.1`：和 `rust-v0.160.0` 比只删了每个型号里已废弃的 `"instructions_variables": null`，其余逐字相同；`codex-model-catalog.ts` 的 tag 与 sha256 同步改。
