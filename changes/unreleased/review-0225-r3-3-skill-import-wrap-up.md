## 开发

- 0.2.25 复查第三轮第 3 条（技能导入收尾）：导入不成功时，界面上照旧是原本的原因（比如「Skill 已存在」），
  技能文件夹里不留下多余的技能。`skill-import-snapshot.ts` 的 `discardSkillImportStaging` 收尾不再抛错；
  列技能（`codex-extensions.ts` 的 `collectSkillFiles`、`provider-extensions.ts` 的 `scanSkills`）不列导入用的临时文件夹；
  开机安静期过后由 `discardSkillImportLeftovers` 在后台清掉以前留下的（Codex、Claude Code、Grok 自己的和当前项目的技能文件夹，
  只认星芒起名的、不跟链接，这会儿还有导入在用的不碰）。
- 用例：`skill-import-snapshot.test.ts`、`codex-extensions.test.ts`、`provider-extensions.test.ts` 补了 7 条，旧代码上都红。
