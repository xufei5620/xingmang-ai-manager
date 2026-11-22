## 开发

- 审查总表 O17（0.2.25 总单第四节 W13，设计由 Claude·win 牵头）：本地技能导入全程只复制当初核过的那份内容，期间有变化就停止，不留半成品。
  新模块 `electron/skill-import-snapshot.ts`，`codex-extensions.ts` 的 `resolveSkillImportSource` / `stageSkillImport` / `commitSkillImport` 改用它；
  Codex 的 `importSkill`、Claude Code 和 Grok 的导入（`provider-extensions.ts`）、「从压缩包导入」解开的那份都走这里，`forgetSkillEnablement` 的时机不变。
- 用例：新增 `electron/skill-import-snapshot.test.ts`；`codex-extensions.test.ts` 补两条（旧代码上红），`provider-extensions.test.ts`、`skill-archive.test.ts` 各补一条。
- 没做：卸载技能跨盘时退回到「复制再删」那条（`moveSkillToTrash`）处理的是受管目录，不算导入，照旧；导入中途星芒被强行结束时，技能目录里留下的临时文件夹不会自动清。
