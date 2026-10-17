## 开发

- Windows、Linux 上用星芒账号从星芒打开 Claude Code 时，也像 Mac（#920，已知45）那样不把环境里的 `ANTHROPIC_API_KEY`、`CLAUDE_CONFIG_DIR` 交给它（#1081）：前者会多带 `x-api-key` 顶掉当前账号的 Key，后者让它整个不读星芒写的 `~/.claude`，原来只靠检查页提示，首页却显示正常。`electron/system-service.ts` 的 `launchExcludedEnvironmentVariables` 三个平台共用，Mac 的 `macosShellOverrideVariables` 直接复用它，Linux 交给已开着的命令窗口时脚本里照样再 unset 一次。客户系统里的设置一个字不动；用自己的 Claude 账号时照旧都带。检查页那条「待处理」照旧（客户自己开命令窗口直接跑时仍会绕开），没改字。
