## 用户

- 在 Codex 里自己关掉「星芒AI」技能的，以后打开星芒、保存配置、切到 ChatGPT 账号再切回星芒都不会再被打开。只有切到 ChatGPT 账号时星芒替你关的那一次，
  切回星芒时才会打开。
- 用星芒之前自己关掉 Gemini CLI 使用统计的，切回 Google 账号以后统计照旧关着，不会被悄悄打开。
- 用星芒之前在 Codex 里自己设过上下文长度的，第一次打开星芒不会再被删掉，只清理老版本星芒自己写过的那两个值。

## 开发

- #834 核实 F07（已知17）：`syncXingmangAiSkillCodexAvailability` 以前开关直接等于「不是 ChatGPT 账号」。开机时 `main.ts` 的默认安装、
  登录同步、保存配置、切回星芒都会走到它，用户自己在 Codex 里关掉的技能每次都被打开。现在在 config.toml 旁边记
  `xingmang-ai-skill-state.json`（`offByXingmang`）：ChatGPT 账号下关技能时记「切回星芒时配置里的关是不是这里星芒关的」，按
  `xingmang-config-relay.toml` 定：那份里技能本来就关着就是用户的（记 false），没有那份（切回时会把 ChatGPT 配置整份带过去）或里面没关
  才记 true；已经记着 true 的不改（上次在星芒下没打开成时，那个关会被原样存进那份）。切回星芒时只打开记着 true 的那个关，
  并把 `xingmang-config-relay.toml` 里同一条一起打开，免得切换失败回滚（只还原 config.toml）后再切过来又带回这个关。
  没有记录的老配置：星芒下的关算用户的，ChatGPT 账号下的关同样按 `xingmang-config-relay.toml` 定。
  `applyXingmangAiSkillEnabledFlag` 遇到同一技能写了好几条时一起改。
- #834 核实 F03（已知15）：Gemini 的 `privacy.usageStatisticsEnabled = false` 以前切回 Google 时只要 privacy 里就这一项就整段删，
  分不清是星芒写的还是用户自己写的。现在星芒写下它时（保存配置、重置、开机补缺省）在 settings.json 旁边记
  `xingmang-gemini-usage-statistics.json`，和 settings.json 同一次两阶段提交；切回 Google 只收回有记录的那一项，再把记录写空。
  有记录之前写下的那些分不清是谁的，切回时留着：关着统计不影响任何功能。备份只还原 settings.json 和 .env，所以
  `adoptRestoredConfig`（切换失败的回滚、备份页恢复都走它）在登记来源之前调 `forgetStaleGeminiUsageStatisticsRecord`：恢复出来的
  settings.json 里没有那个 false 了，记录就作废。
- #834 核实 F04（已知16）：`removeCodexContextLimits` 只删值和老模板（#104 加、#124 撤）一样的 `model_context_window = 1000000`、
  `model_auto_compact_token_limit = 900000`，用户设的别的值留着；`docs/CODEX-ACCOUNT-CONFIG.md` 跟着改。升过 0.2.5 的机器早就跑完了
  这次一次性清理，只影响先在 Codex 里设过这两项、后来才第一次装星芒的人。
