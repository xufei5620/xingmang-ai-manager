## 用户

- Mac 上在终端设置（`~/.zshrc` 这类文件）里另外设过 Claude Code、Gemini CLI 的 Key 或配置目录的，从星芒打开这两个工具时
  照样用星芒的账号，不会被那几行换掉，和 Windows 上一样。那几行设置和你自己开的终端都不改。

## 开发

- 已知45（第三十四批跟进项 1）：和第三十四批 B 同一条路，macOS「终端」先起客户的登录 shell 读 `~/.zshrc` 等文件，
  里面 export 的变量一路带给工具；星芒从访达打开，自己的环境里没有它们，`providerCommandEnvironment` 管不到。
  `system-service.ts` 新增 `macosShellOverrideVariables(provider)`：Claude Code 是检查页实测会绕开当前账号的
  `ANTHROPIC_API_KEY`（多带 `x-api-key` 换掉 Key）、`CLAUDE_CONFIG_DIR`（整个不读 `~/.claude`），即 `diagnostics.ts` 的
  `breaksAccount`；Gemini CLI 是 `providerCommandEnvironment` 在 Windows、Linux 上本来就不交给它的五个（抽成模块级常量共用）；
  Codex（`CODEX_HOME` 星芒每次自己写，`OPENAI_*` 盖不过 config.toml）、Grok（没实测过）不动。
- `buildDarwinCliLaunchPlan` 多收 provider，把名单放进计划的 `clearedEnvironmentKeys`；`buildMacosTerminalScript` 在进文件夹
  检查之后、export 之前 `unset` 它们，星芒自己的值（Gemini 的 Key、地址、模型）随后照旧写回。名字按环境变量名校验，不合格抛错；
  没给名单时脚本和以前一字不差。`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 盖不过 settings.json 的 env 段，不动。
  不加新字。客户自己开的终端照旧会读这些设置；检查页在 Mac 上把它们查出来那一半要新字，另做。
- 单测：Mac 启动脚本里 `unset` 排在进文件夹检查之后、第一条 export 之前，没给名单时不出这一行，四种不像变量名的写法都抛错；
  有 `/bin/zsh` 时用真 zsh 跑整份启动脚本，登录 shell 带进来的 `ANTHROPIC_API_KEY`、`CLAUDE_CONFIG_DIR`、
  `GOOGLE_GENAI_API_VERSION` 到不了工具，`GEMINI_API_KEY` 是星芒那份，名单外的照旧带上，stderr 为空。`system-service`
  这边钉住检查页那四个「待处理」变量都在名单里、Gemini 的名单和 Windows、Linux 去掉的一样、Codex 和 Grok 不动。
  去掉 `unset` 那一行，两条红。没在真 Mac 上演过。
