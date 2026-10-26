## 用户

- 外接工具的「自定义连接」可以把提供方给的一整段配置直接粘贴进去，下面几项自动填好；要带密钥的网络服务现在也能加了。

## 开发

- 同类对比第 1 条（`/mnt/project-files/优化研究/同类对比.md`）。`features/extensions/mcp-paste.ts`：粘贴框认
  `mcpServers` / VS Code `servers` / OpenCode `mcp` / Zed `context_servers`、单独一条、`"名字": { … }`（JSONC，带注释、
  尾逗号、中文引号也认）、Codex / Grok 的 `[mcp_servers.名字]`（只认片段用得到的一小块 TOML，认不全就整段不认）、一行启动命令、
  一个地址、`claude|codex|grok mcp add …` 和 `claude mcp add-json`。认出来的照原样填进原表单，提交照旧走 `submitMcpInstall`；
  SSE（Codex 不认）和别的连接方式不悄悄换成 http，直接说加不了。还是示例文字的设置、请求头（`<…>`、`${…}`、YOUR_…KEY、
  「您在…申请的」）点名提醒，不拦。
- 网络服务补请求头：`ProviderMcpInstallConfiguration` / `HttpMcpInput` 的 http 分支加可选 `headers`，缺省 = 旧行为。
  Claude Code 2.1.310 拼 `--header "名称: 值"`（可变参数，放在名字和地址后面），Grok 1.0.70 放在前面（一个开关一个值）；
  `codex mcp add` 0.164.0 没有请求头开关，带请求头时装没装 CLI 都直接写 config.toml 的 `http_headers`（沙箱里三家实测，
  Codex 用 `mcp get --json` 核过认得）。值进 `sensitiveValues`，列表照旧只回名字。校验在新的零依赖模块
  `electron/mcp-http-headers.ts`（名字是不以 - 开头的 HTTP token，值不许换行和 NUL），IPC 解析、主进程拼命令和界面共用。
- 「自定义连接」加之前先问勾上的别的工具有没有同名连接（`mcpNameTakenIn`）：Codex、Grok 加同名的会把原来那条整条换掉，
  客户在那边自己配好的密钥就没了。读不到列表的工具不拦。
