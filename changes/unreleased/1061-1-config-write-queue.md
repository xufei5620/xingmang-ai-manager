## 开发

- 保存配置以外替客户改工具配置的几处排进保存配置那一队（#1061 第 1 条）。保存要先联网查模型，
  查完核对配置没被动过才写（`sameNativeConfigSnapshot` 连修改时间一起比），以前这一两秒里点
  「打开 Codex」，打开前补的权限缺省值或桌面端中文一改 `config.toml`，保存就报「工具配置在模型
  检测期间发生变化」（新测试在旧代码上复现）。
- 打开前补写的三样（Codex 权限缺省值、Windows 上桌面端自动设中文、Claude Code 的工作目录信任）
  走 `system-service.ts` 新的 `writeQueuedWithin`：最多等 3 秒，排不上这次就不写、之后轮到了也不再写，
  不会在工具起来以后跟它抢同一个文件。配置窗口里「信任工作目录」和切桌面端语言两个按钮等保存做完再写，
  重开桌面端放在队外。
- `SystemService` 多一个可选的 `serializeToolConfigWrite`，就是保存配置那一队。`main.ts` 登记星芒画图
  工具（`syncXingmangImageMcpConfigs`，改 Codex、Grok 的 `config.toml` 和 Claude 的 `settings.json`、
  `.claude.json`）和开机、同步账号时星芒AI技能跟着账号开关（`installXingmangAiSkillFiles` 新的
  `serializeConfigWrite` 选项）都排进去。扩展页启停插件、加删 MCP 不在这次范围里。
