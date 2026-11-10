## 用户

- Claude Code 从当前账号切回官方账号时，星芒替你开的「不逐条确认就执行」会跟着关掉，回到官方原样：之后官方 Claude Code 跑命令前会照常问你。你自己设过的权限模式不动。
  这一版之前就接过星芒的电脑不变，想让官方 Claude Code 逐条问，请在 Claude Code 里自己改回权限模式。

## 开发

- 0.2.24 深查 D5（反复切换 N7，2026-11-10 yoyo 批「按照推荐做」，改字修复批次 P03）：接当前账号时
  `skipClaudeCommandConfirmation` 对没设过的客户补 `permissions.defaultMode = "bypassPermissions"` 和
  `skipDangerousModePermissionPrompt = true`，切回官方（`createOfficialAccountPlans`）有意不删，官方 Claude Code 也不问就执行。
  现在补上的那几项记进同一份快照 `xingmang-claude-foreign-settings.json` 的新栏 `filled`（`recordClaudeFilledDefaults`），
  切回官方时 `withdrawClaudeFilledDefaults` 只撤记下的、而且值还是星芒写的那个的，`permissions` 撤空就连键删；撤完照旧清空快照。
  merge、reset、开机补设置（`fillClaudeRelayTemplateDefaults`）三条都记；还没有 settings.json 的新客户走模板时，快照那份计划
  现在也一起写（以前只写 settings.json）。
- 记号只认这一次：写之前是官方账号的样子（`claudeSettingsLookOfficial`）时旧记号作废，只记这次补上的，因为备份不带这份快照，
  切到当前账号失败按备份退回官方后，客户自己再开的同一项不能当成星芒补的；一直接着当前账号时旧记号照旧算，值被客户改过的作废。
- 0.2.24 之前就接过星芒的配置快照里没有记号，分不清那两项是不是客户自己设的，切回官方时照旧不动（项目规矩：客户自己设过的值不动）。
  `effortLevel` 不在这次范围里，照旧留着。
