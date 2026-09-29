# 中转账号的桌面端图片能力

星芒登录的普通 API Key 不能启用 Codex Desktop 内置的 ChatGPT `image_gen.imagegen` 执行器。该执行器在当前 Codex 运行时还要求 Codex backend 认证；仅配置 `base_url`、`OPENAI_API_KEY` 和 `requires_openai_auth` 不满足这个条件。

本项目现在提供一个受管 MCP 连接 `xingmang-image` 作为兼容路径：账号同步成功后，星芒会把 MCP 服务器写入用户的 Codex `config.toml`。用户在桌面端直接说“画一张图”，模型可以调用 `generate_image`；服务器经星芒图片中转请求 `/v1/images/generations`，再通过 MCP image content 把图片返回到当前对话。

这个路径的用户体验是：

- 不需要安装或手动输入星芒 Skill 命令。
- 图片会在 Codex 对话中显示，并使用桌面端通用图片查看、复制和下载能力。
- 图片模型由调用参数选择，默认 `gpt-image-2`，也支持当前中转已验证的 `gpt-image-2.5-flare` 与 `gpt-image-2.5-sunburst`。

它仍然与官方内置 `image_gen` 有边界：MCP 结果属于 generic image content，不会自动进入官方 `generated-image` 画廊、原生图片编辑历史或官方图片额度展示。原生 ChatGPT 登录不安装这条 MCP，避免和官方执行器重复。

安全边界：

- API Key 只留在星芒 Skill 配置文件，由 MCP 子进程按路径读取；不会写入 MCP 的 TOML `env` 值。
- MCP 只允许 HTTPS 中转地址、受限图片模型、固定 `/v1/images/generations` 路径，拒绝重定向并限制响应大小和超时。
- 账号同步发现已有同名 MCP 时不覆盖用户配置；需要替换时由用户在 MCP 页面手动处理。
- 退出账号只清除 Skill 配置中的 Key，保留 MCP 条目；调用时会返回“缺少图片分组 Key”，不会使用旧凭据。
