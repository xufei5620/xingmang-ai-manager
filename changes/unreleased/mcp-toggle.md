## 用户

- Codex（包括只装了 Codex 桌面端）和 Grok CLI 的外接工具可以在星芒里停用、再打开了，不用删了重加、重填参数。

## 开发

- 外接工具的启停按各家自己的做法接上，界面沿用已有的开关和「已启用 / 已停用」提示，没加新字。
- Grok：`grok mcp enable|disable <名字>`（1.0.52、1.0.70 实测，没有 `--scope`，在项目目录里跑才找得到项目那层；
  停用会把名字记进 `~/.grok/config.toml` 的 `disabled_mcp_servers`，重复点照样退出 0）。`nativeOperations` 给 Grok 放开。
- Codex：没有启停命令，停用就是用户 `config.toml` 里那条写 `enabled = false`（0.162.1 实测 `mcp list` 报 disabled，
  `codex mcp add` 别的连接不会冲掉）。新的 `CodexExtensionService.setMcpServerEnabled` 按行改这一个值（启用写回 `true`，
  不删键，免得整份重写），走 `mutateCodexConfigToml`（备份、原子替换、排队），写完按 `codex mcp list` 或配置文件对账，
  装没装 CLI 都一样。`ProviderExtensionService.mutate` 把 Codex 外接工具的启停转给它（新选项 `setCodexMcpServerEnabled`，
  `main.ts` 接上；缺省不给开关，旧行为），不跑命令；项目里那几层和插件带的改不到，跟「移除」一样不给开关。
- Claude Code 这次不做：它没有启停命令，自己的「停用」只记在 `~/.claude.json` 里当前项目文件夹那一份（2.1.310），
  换个文件夹照样启用，跟列表上「所有项目都能用」那组对不上，要加说明字才行。
- legacy 的 `McpPage.tsx` 按 `operations` 画启停按钮，Codex、Grok 那两格跟着出现，走的同一条 `extensions:mutate`，代码没动。
