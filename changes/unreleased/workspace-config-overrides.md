## 用户

- 打开 Claude Code、Codex、Gemini CLI 时，如果选的项目文件夹里有自己的设置、会让工具不用当前账号（余额和用量会对不上），打开后会用一句话提醒你；公司电脑上统一下发的设置也会提醒。本软件只提醒，不改你项目里的任何文件。
- 「检查」页新增「项目文件夹里的设置」一项：最近打开的项目文件夹里有会盖过当前账号的设置时标出来，一定连不上当前账号的标「待处理」，可能有影响的标「需留意」。

## 开发

- 新模块 `electron/workspace-config-overrides.ts`（只读纯判定）：Claude Code 看工作目录下 `.claude/settings.json` / `settings.local.json` 与管理策略（`managed-settings.json` 与 `managed-settings.d/*.json`，Windows `C:\Program Files\ClaudeCode`、macOS `/Library/Application Support/ClaudeCode`）里的 `env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY`、云厂商开关与 `apiKeyHelper`；Codex 看工作目录到 git 根的 `.codex/config.toml` 里的 `forced_login_method = "chatgpt"` 与 `cli_auth_credentials_store = "keyring"`（仅 apikey 模式）；Gemini 看 `.gemini/settings.json` 换登录方式，以及工作目录往上找到的第一个 `.env`（本软件打开时有注入的环境变量压着，只算「自己开终端」）；Grok 项目配置盖不过地址与密钥，不查。规则全部在沙箱里真跑四家 CLI（Claude Code 2.1.277、Codex 0.155.1、Gemini CLI 0.60.0、Grok 1.0.40）对本地假接口核过。读取走 `readBoundedUtf8FileSync`，不跟符号链接（I8）；结果与日志只有脱敏路径和键名（I13）。
- `cli:launch` 返回值从 `void` 改为 `CliLaunchResult { configOverrideNotice? }`（通道没增删，T1 不涉及）；`system-service.ts` 在信任写入与 AGENTS.md 之后检查，记 `workspace.config-override` warn 日志，检查失败不挡打开。渲染层 `features/tools/launch-notice.ts` 统一出打开后的提醒，首页 toast、记录页「接着上次」都接上。
- 诊断新增 `WORKSPACE_CONFIG_OVERRIDE`，看 `settings.workspace`（最近一次选的项目文件夹）与 Claude 管理策略，只看已配置的工具；从本软件打开一定不用当前账号的定 fail，其余 warn。这一项没有「去处理」按钮（`diagnosticHasFix`）。
- 未覆盖：Claude Code 的 Windows 注册表策略（`HKLM\SOFTWARE\Policies\ClaudeCode`）与 macOS 描述文件策略。
