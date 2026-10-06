## 用户

- 在 Codex 里自己关掉「星芒AI」技能的，以后打开星芒、保存配置、切回星芒都不会再被打开。只有切到 ChatGPT 账号时星芒替你关的那一次，
  切回星芒时才会打开。
- 用星芒之前自己关掉 Gemini CLI 使用统计的，切回 Google 账号以后统计照旧关着，不会被悄悄打开。
- 用星芒之前在 Codex 里自己设过上下文长度的，第一次打开星芒不会再被删掉，只清理老版本星芒自己写过的那两个值。

## 开发

- #834 核实 F07（已知17）：`syncXingmangAiSkillCodexAvailability` 以前开关直接等于「不是 ChatGPT 账号」。开机时 `main.ts` 的默认安装、
  登录同步、保存配置、切回星芒都会走到它，用户自己在 Codex 里关掉的技能每次都被打开。现在在 config.toml 旁边记
  `xingmang-ai-skill-state.json`（`offByXingmang`）：ChatGPT 账号下星芒关的记 true，切回星芒时只打开记着的那一个；用户自己的关不动，
  并记 false，这个关被带进第一份 ChatGPT 配置、再切回来也认得出。还没有记录时（老版本留下的配置），ChatGPT 账号下的关算星芒的
  （老版本在那边每次都强行关），星芒下的关算用户的（老版本在这边每次都强行开）。
- #834 核实 F03（已知15）：Gemini 的 `privacy.usageStatisticsEnabled = false` 以前切回 Google 时只要 privacy 里就这一项就整段删，
  分不清是星芒写的还是用户自己写的。现在星芒写下它时（保存配置、重置、开机补缺省）在 settings.json 旁边记
  `xingmang-gemini-usage-statistics.json`，和 settings.json 同一次两阶段提交；切回 Google 只收回有记录的那一项，再把记录写空。
  有记录之前写下的那些分不清是谁的，切回时留着：关着统计不影响任何功能。
- #834 核实 F04（已知16）：`removeCodexContextLimits` 只删值和老模板（#104 加、#124 撤）一样的 `model_context_window = 1000000`、
  `model_auto_compact_token_limit = 900000`，用户设的别的值留着；`docs/CODEX-ACCOUNT-CONFIG.md` 跟着改。升过 0.2.5 的机器早就跑完了
  这次一次性清理，只影响先在 Codex 里设过这两项、后来才第一次装星芒的人。
