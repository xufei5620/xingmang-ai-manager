## 用户

- 三家命令行工具的推荐版本跟上官方最新版：Claude Code 2.1.303（修了一些小问题）、Codex 0.163.0（Windows 上用快捷键能粘贴文字，回复中途断掉时会直接提示出错）、Grok 1.0.62（官方最新的稳定版，画图、起标题照旧走当前账号）。

## 开发

- `electron/cli-verified-versions.ts` 每周巡检（10-19）：Claude Code 2.1.302 → 2.1.303（上游 changelog 只有一句 bug fixes，沙箱对照 2.1.296 请求体字段、工具列表、鉴权头、`/context` 1M 都一样）；Codex 0.162.1 → 0.163.0（release note 没有碰自定义 provider 的条目，随包型号名单的 tag 换成 `rust-v0.163.0`，`models.json` 逐字相同、sha256 不变）；Grok 1.0.52 → 1.0.62（npm latest 且是 xAI stable，假接口上 K1/K3/K4/钩子重核通过；不写 `[endpoints]` 时 1.0.62 出图改为本地报缺凭据，不再连 `api.x.ai`）。依据写进 `docs/CLI-VERIFIED-VERSIONS.md`。
