## 开发

- #1157 第 11 条：用星芒账号从星芒打开 Claude Code 时，环境里让它改走云厂商的五个开关（`CLAUDE_CODE_USE_BEDROCK`、
  `VERTEX`、`FOUNDRY`、`ANTHROPIC_AWS`、`ANTHROPIC_GOOGLE_CLOUD`）也不交给它，三个平台一样，Mac 的启动脚本照样
  unset（`launchExcludedEnvironmentVariables` 加上 `workspace-config-overrides.ts` 导出的 `claudePlatformSwitches`）。
  以前客户环境里留着其中一个，从星芒打开的 Claude Code 就不走星芒，首页仍说已连好。检查页「电脑里另外设过的工具地址或密钥」
  一项也认这五个（设成 0、false 的不算），用原有字样报；Windows 上「删掉这几项设置」不删它们，设它的人多半自己在终端里
  用 Bedrock、Vertex。客户 settings.json 里写的同名项不挪，那是客户自己设的值。用自己的 Claude 账号时照旧都带。
- #1157 第 14 条：macOS、Linux 和 Windows 管理员身份装命令行工具时，先把正在用的工具目录复制进暂存目录；这一步跟从哪个源
  下的无关，以前它失败（多半是没权限读）也当「这个源不行」换下一个源从头再下一遍，最后还是撞上同一个错。现在这一步怎么失败
  的都停在这个源，运行日志 `cli.install.machine-bound-failure` 多记 `copyingFolderInUse`。
- #1157 第 15 条：界面上的「关闭支付窗口」改用 `destroy()`，同到账、过期自动关那条；`close()` 会被付款页的 beforeunload
  拦下，界面说关了，窗口却还开着。关窗后照旧接着确认到账。
- 没有新增或改动界面文字。
