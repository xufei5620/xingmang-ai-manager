## 用户

- 修复从网上复制粘贴 MCP 配置时，参数里以 `-` 开头的内容会被 Gemini CLI 当成自己的选项处理的问题；
  现在这类参数会原样交给 MCP 服务器，不会再意外改掉服务器的信任级别或工具范围。

## 开发

- `provider-extensions.ts` 的 `mcpInstallArgv` 在 gemini 分支补上 `--` 分隔符，与 codex / claude / 兜底三条对齐
  （审查总表 E-G3）。`@google/gemini-cli` 的 `mcp add` 用 `parserConfiguration({'unknown-options-as-args': true,
  'populate--': true})` 加一条 middleware 把 `argv['--']` 并回 `args`，所以分隔符放在 `<commandOrUrl>` 之后。
- 新增跨四个 provider 的回归测试，钉住「用户提供的以 `-` 开头的 MCP 参数一律落在 `--` 之后」。
