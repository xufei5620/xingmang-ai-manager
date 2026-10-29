## 开发

- 手机遥控：遥控开的对话不再带客户自己给 Codex 接的外部工具（#1407 P2-4 第二件，yoyo 10-29「按推荐」）。MCP 服务、插件、
  ChatGPT 应用的工具调用不一定走审批，手机上看不到也拦不住。现在 `thread/start` 带 `config` 覆盖：`features.apps` 和
  `features.plugins` 关掉，`mcp_servers` 逐个设 `enabled = false`。名字由开对话前的 `config/read`（`cwd` = 遥控文件夹、
  `includeLayers: true`）逐层收集，没被信任过的项目 `.codex/config.toml` 也算（workspace-write 下 `thread/start` 会当场信任并
  加载它）；只在这种层里出现的服务连同它的 `command` / `url` 一起带上，不然 Codex 会因为「没有启动方式」拒掉整份配置。
  `config/read` 失败就不开对话。只改这一份对话，`config.toml` 不动，电脑上直接用 Codex 照旧，联网搜索不动。
