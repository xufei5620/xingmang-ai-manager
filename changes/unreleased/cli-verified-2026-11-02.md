## 用户

- Claude Code、Codex 的推荐版本跟上官方最新版：Claude Code 2.1.316（修好了一些情况下提问被拒要反复重试、网络不稳时回复卡住不动的问题）、Codex 0.166.0（重新打开或分出对话时权限设置不会丢，选到不存在的型号时不再反复重试）。

## 开发

- `electron/cli-verified-versions.ts` 每周巡检（11-02）：Claude Code 2.1.310 → 2.1.316（2.1.311～2.1.316 没有网关回归，2.1.314 补了网关按名字拒收 beta 头、拒收工具搜索 `tool_reference` 时的重发；沙箱假接口上问答、工具搜索被拒后的回退、`haiku` 别名、`/context` 1M、备用型号与 2.1.310 一致）。Codex 0.164.0 → 0.166.0（release note 没有碰自定义 provider 的条目；随包型号名单换成 `rust-v0.166.0`，比上一份多一个 `gpt-6.1-terra`，其余逐字相同，`openai_models.rs` 只加可选字段；沙箱 `debug models`、`exec`、`--no-daemon exec` 与手机遥控用的 `app-server` 一轮对话都通过，0.164.0 也读得进新名单）。Grok 仍是 1.0.70（npm latest 与 xAI stable 都没动）。依据写进 `docs/CLI-VERIFIED-VERSIONS.md`。
