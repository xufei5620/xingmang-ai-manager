## 开发

- 新增主链路冒烟（0.2.24 深查·测试和CI CV-1）：`scripts/cli-config-smoke.cjs`，本地 `npm run smoke:cli-config`，CI 是 quality 工作流的
  `cli-config-smoke` 作业、进 quality-gate 必过项，每个改了代码的 PR 都跑。用主进程真正写配置的 `saveProviderConfig` 把客户那份配置写进临时主目录
  （参数照登录后自动写的那一笔），只把站点地址换成本机假中转（`scripts/cli-config-smoke-relay.cjs`，接 HTTP 和 Codex 的 WebSocket，
  WebSocket 照 new-api 只认 `response.create` / `response.cancel`），再用名单里钉住的 Claude Code、Codex、Grok 在干净环境里各真跑一句，
  断言请求带着写进去的密钥和型号到了假中转、回答打了出来。不要密钥，换完地址还留着线上地址就不跑，不对线上发请求。
- PR 上同时拿 base 上钉的版本跑一遍，推荐版本变了的工具把新旧两版发出去的请求（路径、请求头、beta 与功能标记、请求体字段、WebSocket 消息类型）
  列成差异表写进 job summary，只报不拦；每周巡检抬版本时用 `--compare-with origin/main` 代替手工对比（`docs/CLI-VERIFIED-VERSIONS.md`）。
