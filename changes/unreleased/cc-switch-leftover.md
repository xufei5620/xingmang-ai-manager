## 用户

- 以前用 CC Switch 配过 Claude Code、Codex、Gemini CLI 或 Grok CLI 的电脑，登录后首页会标出「CC Switch 的设置」，说明这个工具还连着 CC Switch 里选的那一家、没有用当前账号，旁边一颗「改用当前账号」：先备份原来的设置，再换成当前账号并试连一次。以前这种情况只显示「用的是别处的配置」，要自己去配置里点「重置为初始状态」才生效。想继续用 CC Switch 的，在「…」里选「就用现在这份」就不再提示。
- 换过来之后，CC Switch 另外写进 Claude Code 的 Fable 型号和子任务型号也会一起收起来，不会再把这两类请求送去别家的型号名。

## 开发

- 新增 `electron/cc-switch-leftover.ts`：用户主目录有 `~/.cc-switch` 数据目录且配置里有别处的连接记 `provider`，密钥是 CC Switch 代理接管占位 `PROXY_MANAGED` 记 `proxy`；`buildConfigSummary` 把它挂到 `NativeConfigSummary.ccSwitchLeftover`（可选字段，不加 IPC 通道）。
- 渲染层 `ccSwitchLeftoverFor` 只在来源为 unknown / changed 且没有「就用现在这份」标记时生效；首页新状态 `ccSwitch`，按钮走现成的 `config:switch-account-source`（备份 → explicit 合并写入 → 连接自检 → 失败回滚）。
- `claudeForeignEnvKeys` 增加 `ANTHROPIC_DEFAULT_FABLE_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`（CC Switch 会写；Claude Code 2.1.277 实测 `--model fable` 会被前者改道）。
