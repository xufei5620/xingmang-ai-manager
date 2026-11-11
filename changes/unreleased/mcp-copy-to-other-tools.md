## 用户

- 外接工具页里，Claude Code 和 Codex「我的（全局）」那份里你自己加的连接，「…」菜单里多了「也装到别的工具…」：勾上别的工具点「装上」，同一条连接（连同填过的密钥、环境变量和请求头）就装进那些工具，不用再照着抄一遍。

## 开发

- 同类对比 备选 5：新通道 `extensions:copy-mcp`（`McpCopyInput { from, to, name }`，只带名字）。主进程用
  `ProviderExtensionService.readUserMcpConnection` 从来源工具「我的（全局）」那份原样读这一条（Claude Code 读 `~/.claude.json` 的
  `mcpServers`，Codex 读 `config.toml`），交给新的纯函数 `mcp-copy.ts` 的 `mcpCopyConfig` 换成添加那条路收的样子，再照手填添加走：
  装进 Codex 走 `addMcpServer`，别的走 `mutate`（`scope: 'user'`），命令、参数、地址、请求头照样过各自添加时那道检查（I1、I5）。
  环境变量、请求头的值不过 IPC（I3），界面本来也只拿得到名字。
- 搬不全的不搬：来源带着别的工具没有同样写法的设置（Codex 的 `bearer_token_env_var`、`env_vars`、`cwd`、超时、工具白名单，
  Claude Code 的 `oauth`、`headersHelper`、`sse` 类型等）、Claude Code 那种要它自己展开的 `${…}`、格式不对，都整条拒绝并说原因，
  不悄悄丢一截。项目里的连接不给搬（常跟着仓库走，搬进别的工具的项目配置等于把密钥写进仓库文件）；Grok 的连接列表不带环境变量和请求头，
  不当来源。
- 界面：`extensions-common.tsx` 的 `mcpCopyOffered` / `mcpCopyChoices`，`ExtensionsPage.tsx` 的弹窗 `mcp-copy`。打开时先问一遍别的工具
  有没有同名的（有就标「已添加」不给勾），装之前再问一遍；一次装一个工具，中途失败的话已经装上的标成「已添加」，再点只补剩下的。
