## 用户

- 三家命令行工具的推荐版本跟上官方最新版：Claude Code 2.1.319（修好了一些情况下提问被拒要反复重试、网络不稳时回复卡住、接着上次聊时偶尔丢掉前面对话的问题）、Codex 0.167.0（重新打开对话时权限设置不会丢，选到不存在的型号时不再反复重试，换过账号后旧对话也找得到）、Grok 1.0.77（官方最新的稳定版，画图、起标题照旧走当前账号）。

## 开发

- `electron/cli-verified-versions.ts` 每周巡检（11-02 那次核过、没合，11-09 并成一次）：Claude Code 2.1.310 → 2.1.319（2.1.311～2.1.319 没有网关回归，2.1.314 补了网关按名字拒收 beta 头、拒收工具搜索 `tool_reference` 时的重发；2.1.314 引入、2.1.318 修好的 `--continue` 丢前文不进 `blocked`；沙箱假接口上问答、工具搜索被拒后的回退、`haiku` 别名、`/context` 1M、备用型号与 2.1.310 一致，新 `install.cjs` 在同一前缀全局升级正常）。Codex 0.164.0 → 0.167.0（release note 没有碰自定义 provider 的条目；随包型号名单换成 `rust-v0.167.0`，比上一份多一个 `gpt-6.1-terra`，其余逐字相同，`openai_models.rs` 只加可选字段；沙箱 `debug models`、`exec`、`--no-daemon exec` 与手机遥控用的 `app-server` 一轮对话都通过）。Grok 1.0.70 → 1.0.77（npm latest 且是 xAI stable，假接口上 K1/K3/K4/钩子与装插件的 `--trust` 重核通过）。依据写进 `docs/CLI-VERIFIED-VERSIONS.md`。
- `scripts/probe-cli-relay.cjs`（中转实测）：关掉子进程的标准输入（Codex `exec` 原来一直等输入到超时）；超时单列成 `timeout`；Claude Code 改用 `--output-format stream-json --verbose`，被超时杀掉时也能按每次重试的 HTTP 状态归类，并把重试上限设成 2 次，让中转回的原话进得了结果。11-09 真跑：Codex 0.167.0 在 `solov` 上通过（`verifiedSites` 填 `['solov']`）。Claude 改用单独的仓库 secret `XINGMANG_CLI_PATROL_KEY_CLAUDE`（Claude 分组；没配就退回共用的 `XINGMANG_CLI_PATROL_KEY`），仓库级 secret 名单与 `docs/RELEASING.md` 一起登记。换了这把之后 Claude Code 2.1.319 也在 `solov` 上通过（`verifiedSites` 填 `['solov']`）。历史账号站 `solov-api` 巡检密钥认不了（401），按 11-09 的决定不再探测，summary 里写明「未在中转实测」。
