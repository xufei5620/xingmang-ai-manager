## 用户

- 本机聊天记录不再一个月就自动消失：由本软件配置的 Claude Code 与 Gemini CLI，保留期从
  一个月放长到一年，你自己设过保留期的照旧按你设的来。记录页也写清了记录只存在这台电脑上。
- Claude Code 现在默认用中文回答，会话标题也跟着是中文，不用每个项目都放一份说明文件；
  你自己设过语言的不动。
- 检查页不再把本软件自己写的「执行命令不用逐条确认」当成风险警告，改成一句说明；配置不是
  本软件写的时候仍然提醒。

## 开发

- 第五批候选 2 / 5 / 3（第一步）。
- `electron/config-files.ts` claude 分支：`createPlans` 模板写 `language: '简体中文'` 与
  `cleanupPeriodDays: 365`；`createMergePlans` 走 `ensureClaudeResponseLanguage` /
  `extendClaudeSessionRetention`，两者都只在键缺省时补，用户写过什么值都原样保留。
- `electron/config-files.ts` gemini 分支：模板写 `general.sessionRetention.maxAge = '365d'`；
  merge 走 `extendGeminiSessionRetention`，只在 `general.sessionRetention` 整段不存在时才补，
  已经有这一段（哪怕只写了 `enabled: false`）就整段不动。
- `createOfficialAccountPlans` 的 reset 模板把这三项一并写回：语言与保留期是用户偏好，切回
  官方账号不该悄悄回到 30 天自动删；merge 路径本来就只删中转那几个键，不受影响。
- `electron/diagnostics.ts`：`CLAUDE_BYPASS_PERMISSIONS` 标题改成「Claude 命令确认方式」，
  `readClaudeBypass` 多收一个来源参数。来源为 `account`（本软件替当前登录账号写的）时
  `state: 'pass'` 并给一句中性说明，其余（`manual` / `unknown` / `changed` / 宿主没给）照旧
  `warn`。来源由新的可选依赖 `readClaudeConfigOwnership` 提供，`electron/main.ts` 用
  `systemService.getConfig(false).providers.claude.configurationOwnership` 接上——判定要比对
  当前登录账号，诊断自己算不出来。不给这个依赖时行为与改动前一致。
- `src/renderer-v2/pages-management.tsx` 记录页 lead 补一句保留期。
- `docs/CLI-VERIFIED-VERSIONS.md` 新增「本软件替用户改了哪些 CLI 默认值」一节，把自更新、
  Artifact deny、命令确认、语言、两个保留期、IDE 模式、目录信任、说明文件名集中成一张表。
- 值的格式都是沙箱实测的：Claude Code 2.1.277 写 `language` 后，请求体系统提示里出现
  `# Language / Always respond in 简体中文.`（值被原样插进那段英文提示）；`cleanupPeriodDays`
  的 schema 是 `int().positive()`，写 0 会被拒，放长只能写大数。Gemini CLI 0.60.0 的
  `general.sessionRetention` 默认 `enabled: true` / `maxAge: "30d"`，且 `getDefaultsFromSchema`
  会递归补齐嵌套默认值——用户没配这一段时清理照样按 30 天跑。
