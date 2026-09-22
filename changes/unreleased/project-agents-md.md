## 用户

- 从首页「打开」进入某个项目目录时，如果目录里还没有 CLAUDE.md / AGENTS.md / GEMINI.md，
  会自动放一份中文的 AGENTS.md 项目说明模板（怎么回复、动手前先说方案、别动哪些目录、
  提交信息格式、跑测试的命令），Claude Code、Codex、Gemini CLI 打开这个目录都会读它，
  内容随时可以自己改。已经有说明文件的目录一律不动。
- 每个目录只生成一次，在 git 里会显示为未跟踪文件，可以随意修改；不需要就直接删掉，
  删了以后再打开也不会再出现。

## 开发

- 新需求候选 5。新增零依赖模块 `electron/project-instructions.ts`：目录里三种说明文件
  （大小写不敏感）任一存在就不生成，否则把随包模板原子写成 AGENTS.md（走 safe-local-data，
  绝不覆盖、绝不追加）。模板独立成文件 `bundled-catalog/project-instructions/AGENTS.zh-CN.md`，
  经 electron-builder 的 `files` 与 `extraResources` 随包发出，`resolveProjectInstructionsTemplatePath`
  沿用 `resolveXingmangAiBundledSkillRoot` 的 packaged→resourcesPath、dev→appPath 解析法。
- Gemini CLI 默认只把 GEMINI.md 当项目说明，`config-files.ts` 新增
  `ensureGeminiContextFilenamesInSettingsText` / `ensureGeminiProjectContextFiles`：在用户级
  settings.json 的 `context.fileName` 里把 GEMINI.md 与 AGENTS.md 都补上，只补不删、已齐不写，
  形态读不懂时整份不动；写入走两阶段提交 + .bak + 回滚（I9）。
- 接线在 `system-service.ts` 的 `launchProviderOperation`，紧接 #284 的信任写入之后：生成项目
  说明对全部工具执行，Gemini 额外补 context.fileName；两步都不阻塞打开，失败只记 runtime.jsonl
  （原因过 redactHomeDirectory，I13）。`SystemServiceOptions` 多一个可选
  `projectInstructionsTemplatePath`，`main.ts` 传入。
- 「每个目录只生成一次」：`ProjectInstructionsStateStore` 把「已为该目录生成过」记在本应用
  数据目录的 `project-instructions/` 下，一个目录一个以路径摘要命名的小文件（沿用
  `ToolConfigOwnershipStore` 的写法，省掉一份会无限长的清单，也没有并发合并），**不往客户
  目录写任何标记文件**。客户删掉生成的 AGENTS.md 就是不想要，下次打开不再生成；记录损坏时
  也当成已生成过 —— 这个方向的代价只是少一份模板，反过来是擅自改动客户的目录。
