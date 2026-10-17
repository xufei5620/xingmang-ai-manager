## 开发

- 各工具的默认型号、上一代默认、已下架型号可以从服务状态文件下发（`service-status.json` 的 `cliModels`，
  #1059 型号那一段）：`electron/cli-model-defaults.ts` 改成程序自带一份、和下发的合并，读不到、格式不对、
  名字不合法的照旧用自带的；默认型号只在账号模型列表里真有的型号里挑，下架名单只换掉账号已经不再列出的型号。
  开机替换下架型号从只有 Codex 扩到 Claude Code 和 Grok（自带名单里这两家是空的，线上不写就没有变化），
  规矩同 #1042：只碰当前账号写的配置、工具开着先不换、换之前先备份，Codex 的 WebSocket 开关照旧跟着型号走。
  service-status 工作流加了「型号表」一项，写法见 `docs/SERVICE-STATUS.md`。只有 0.2.20 及以后的客户端认。
