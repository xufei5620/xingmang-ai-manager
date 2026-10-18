## 用户

- 给 Grok CLI 加外接工具时选「当前项目」，现在会加进当前项目；已加的按「用户」「项目」分开列，移除哪条就只动那一处。
- Grok CLI 的插件只能装给自己用，添加时不再给「当前项目」这个选项（以前选了也是装成全局）。

## 开发

- #1092（照仓库装 Grok 的同一个来源，npm 上 `@xai-official/grok` 1.0.52 与 1.0.62 的 linux-x64 包，空 `HOME` 跑出来）：
  `grok mcp add/remove` 有 `--scope user|project`，project 是命令所在目录的 `./.grok/config.toml`，`mcp list --json` 每条都带
  `scope`；`grok plugin install/uninstall/enable/disable/update` 都没有范围参数，装进 `~/.grok/installed-plugins/`、启停写
  `~/.grok/config.toml` 的 `[plugins]`，`plugin list --json` 不带 `scope`，项目里 `.grok/plugins/` 的插件它既不列也认不出。
- 外接工具：`mutate` 的 `projectBound` 加上 Grok 的 MCP（带 `cwd = repositoryRoot`，项目层没选工作目录先拦），以前不带目录，
  `--scope project` 写进了主进程自己的启动目录；`list` 跑 Grok 的 `mcp list --json` 时带同一个目录，`rawMcpFromJson` 收下
  `scope: user/project`，没带的按 Grok 的缺省 user 算；`registry/extensions.ts` 里 Grok 连接分「用户」「项目」两组。
- 插件：Grok 插件列表的缺省层标 user（以前是 null，界面上归进一组叫「未提供」的）；分组改成一组；添加表单不给「当前项目」
  （`extensionFormOffersProject`）；主进程收到 Grok 插件的非 user 层直接拒，不再悄悄装成全局。
- 没改：Codex 0.162.1 的 `mcp list --json` 在受信任项目里会把项目 `.codex/config.toml` 的连接也列出来、且不带层，`codex mcp`
  也没有范围参数；星芒列 Codex 连接时不带目录，所以那些连接看不到。要不要列、怎么删，另做。
