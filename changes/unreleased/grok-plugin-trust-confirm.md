## 用户

- Grok CLI 的「添加插件」能装上了。点「添加」后先弹一个确认框，说清插件装好后会在电脑上自动运行哪些东西，点「信任并安装」才装；点「先不装」回到表单，什么都不装。

## 开发

- Grok CLI 装插件不带 `--trust` 一律拒绝：1.0.52（推荐版）和 1.0.62 在沙箱里实测都打印英文提示后退出码 1，
  有没有终端都一样，所以「添加插件」以前对 Grok 每次都失败。带了以后插件进 `~/.grok/installed-plugins`，
  它的钩子和 MCP 在之后每次启动 Grok 时自动运行（本地假接口跑 `grok -p` 实测钩子、MCP 命令都执行了）。
  卸载、启用、停用、更新都不需要 `--trust`。
- `ProviderExtensionMutation` 加可选 `trust`；`extensions:mutate` 只认字面量 `true`，别的类型报「扩展操作格式错误」；
  主进程只在 Grok 的 `plugin install` 上带 `--trust`，别家收到也不带。
- renderer-v2 插件页：Grok 的「添加插件」表单提交前叠一个确认框（`plugins-trust-confirm`），确认后才带 `trust: true`。
  legacy 树已冻结，没动，它的 Grok 插件安装维持原样失败。
