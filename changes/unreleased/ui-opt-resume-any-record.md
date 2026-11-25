## 用户

- 记录页的每一条对话均可「继续对话」。

## 开发

- 记录页「继续对话」三家都带记录 id：`cli:launch` 第四个参数放开到 `claude:` / `grok:` 加 64 位十六进制（`parseResumeRecordId`），主进程用 `ProviderSessionsService.resolveResumeTarget` 从记录里读出编号（Claude Code 取文件名、Grok CLI 取 `info.id`，只认 UUID）、核对文件夹后按 `--resume <编号>` 接；读不出或文件夹对不上退回按文件夹接最近一条。首页照旧。
