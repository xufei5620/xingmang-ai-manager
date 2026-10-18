## 用户

- Codex CLI 的外接工具页，现在也列出当前项目里写给 Codex 的连接（Codex 信任了这个项目才会用），归在「项目」那组。这些连接只能在项目文件里改，这里不给「移除」；插件带进来的连接也不再给「移除」（以前点了提示已移除，其实还在）。

## 开发

- #1092 Codex 那半（照仓库装 Codex 的同一个来源，npm 上 `@openai/codex` 0.162.1 的 linux-x64 包，空 `HOME` 跑出来）：
  `codex mcp list --json` 在项目里跑，会把受信任的项目层（工作目录一路往上到 Git 根，每层的 `.codex/config.toml`；自己有
  `trust_level` 的看自己，没有的看 Git 根）和用户 config.toml、插件带的连接合在一起列，不带层，同名时项目那份盖过用户那份；
  `codex mcp add` 只写用户那份，`mcp remove` 只删用户那份，别的名字回「No MCP server named … found.」照样退出 0。
- `list` 跑 Codex 的 `mcp list --json` 时带工作目录；`placeCodexMcpServers` 对照文件分层：用户那份没有、项目文件里有的归
  project；两边都有的，只有列出来的跟用户那份一样、跟项目里的都不一样才算 user，其余（包括跟两边都一样、分不清的）算
  project。不在用户那份里的、算 project 的都 `operations.uninstall = false`，
  `mutationArgv` 收到 Codex 连接的 project 层直接拒。`registry/extensions.ts` 里 Codex 连接分「全局」「项目」两组。
  不往客户的项目文件里写，也不改 Codex 的信任设置。
- 工作目录不在了（删了、换了盘），Codex 和 Grok 列连接时就不带目录跑，不再整张列表报错（#1205 以后 Grok 会这样）。
