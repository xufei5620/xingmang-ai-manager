## 用户

- Mac 上在终端设置（`~/.zshrc` 这类文件）里另外设过 Claude Code、Gemini CLI 的 Key 这类设置的，从星芒打开这两个工具时
  照样用星芒的账号，不会被那几行换掉。那几行设置和你自己开的终端都不改；Claude Code 用的是你自己的 Claude 账号时，照旧带上它们。
- 电脑里另外设过给 Claude Code 选型号的设置（`ANTHROPIC_MODEL` 这类，照别家中转教程配过的常有）的，用星芒账号从星芒打开
  Claude Code 时不再带过去，免得它去要当前账号没有的型号；Windows、Mac、Linux 都一样。用你自己的 Claude 账号时照旧带上。

## 开发

- 已知45（第三十四批跟进项 1）：和第三十四批 B 同一条路，macOS「终端」先起客户的登录 shell 读 `~/.zshrc` 等文件，
  里面 export 的变量一路带给工具；星芒从访达打开，自己的环境里没有它们，`providerCommandEnvironment` 管不到。
  `system-service.ts` 新增 `macosShellOverrideVariables(provider, accountMode)`：Claude Code 只在用星芒账号（`relay`）时
  去掉检查页实测会绕开当前账号的 `ANTHROPIC_API_KEY`（多带 `x-api-key` 换掉 Key）、`CLAUDE_CONFIG_DIR`（整个不读
  `~/.claude`），即 `diagnostics.ts` 的 `breaksAccount`；用自己的 Claude 账号时这两个可能就是客户自己的 Key 和登录
  （切回官方时 `config-files.ts` 也把他原来的 `ANTHROPIC_API_KEY` 放回 settings.json），不动。Gemini CLI 不论哪种账号，
  去掉 `providerCommandEnvironment` 在 Windows、Linux 上本来就不交给它的五个（抽成模块级常量共用）。
  Codex（`CODEX_HOME` 星芒每次自己写，`OPENAI_*` 盖不过 config.toml）、Grok（没实测过）不动。
  Windows、Linux 上 Claude Code 的这两个照旧由检查页提示，这次不动。
- 已知45 跟进（协调者定的）：用星芒账号时，三个平台从星芒打开 Claude Code 都不带客户环境里选型号的那几个，范围和接账号时
  从 settings.json 挪开的一致：`config-files.ts` 从 `claudeForeignEnvKeys` 导出 `claudeForeignModelEnvKeys`（去掉
  `ANTHROPIC_API_KEY`），`system-service.ts` 的 `launchExcludedEnvironmentVariables(provider, accountMode)` 只在
  Claude Code 用星芒账号时给出这份名单。打开前 `withoutEnvironmentVariables` 不分大小写地把它们从交给终端的环境里去掉
  （Windows、Linux 两条路都吃这份环境）；Mac 的启动脚本名单也包含它们；Linux 计划多一个可选的 `clearedEnvironmentKeys`，
  启动脚本照样 `unset`，免得交给已经开着的命令窗口程序时，那个程序自己环境里的那份补上来。用自己的 Claude 账号时照旧带。
- `buildDarwinCliLaunchPlan` 多收一个可选的名单，放进计划的 `clearedEnvironmentKeys`；`buildMacosTerminalScript` 在进文件夹
  检查之后、export 之前 `unset` 它们，星芒自己的值（Gemini 的 Key、地址、模型）随后照旧写回。两边的名字都按环境变量名校验，
  不合格抛错；没给名单时计划和脚本都和以前一字不差。`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 盖不过 settings.json 的
  env 段，不动。不加新字。客户自己开的终端照旧会读这些设置；检查页在 Mac 上把它们查出来那一半要新字，另做。
- 单测：Mac 启动脚本里 `unset` 排在进文件夹检查之后、第一条 export 之前，没给名单时不出这一行，四种不像变量名的写法都抛错，
  `launchMacosTerminal` 把计划里的名单带进它写的脚本；有 `/bin/zsh` 时用真 zsh 跑整份启动脚本，登录 shell 带进来的
  `ANTHROPIC_API_KEY`、`CLAUDE_CONFIG_DIR`、`GOOGLE_GENAI_API_VERSION` 到不了工具，`GEMINI_API_KEY` 是星芒那份，名单外的照旧
  带上，stderr 为空。Linux 启动脚本同样排在进文件夹之后、export 之前，四种坏名字抛错，真 `/bin/sh` 跑时命令窗口程序环境里的
  `ANTHROPIC_MODEL` 没给名单时带过去、给了就到不了工具。`system-service` 这边钉住选型号的名单只在 Claude Code 用星芒账号时
  给出、Mac 名单包含三个平台都不带的、Claude Code 的 Key 和配置目录只在星芒账号时去掉、Gemini 的名单和 Windows、Linux
  去掉的一样、Codex 和 Grok 不动、去名字不分大小写；Linux 打开 Claude Code 时，星芒账号下交给命令窗口的环境里没有
  `ANTHROPIC_MODEL`、计划带着名单，自己账号下照旧带上。`config-files` 钉住名单和接账号时挪开的同一批（只差 Key）；
  `diagnostics.test.ts` 逐个变量跑检查页，凡是判成「待处理」的都得在 Mac 启动脚本的名单里。故意改坏八处（去掉 Mac 的 `unset`、
  Claude 不看账号、Claude 名单少一个、`launchMacosTerminal` 不带名单、打开时不去掉、Linux 脚本不 `unset`、Linux 不传名单、
  选型号的名单不看账号），每处都有单测红。没在真 Mac、真 Windows、真 Linux 桌面上演过。
