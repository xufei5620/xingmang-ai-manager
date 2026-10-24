## 用户

- Claude Code、Grok CLI 的技能也能在星芒里「从文件夹导入」、移除了（移除的先放进星芒的回收站）。
- 精选里想加的东西，能用它的工具一个都还没装时，会直接告诉你先去首页装一个，点「去首页安装」就过去。
- 装插件、加外接工具失败时，缺 Git、连不上 GitHub、已经有同名的这三种会直接说明原因和怎么办；外接工具不再挂着点不了的「可更新」，详情里说清楚想换新版本怎么做。

## 开发

- Claude Code、Grok CLI 技能导入、移除（「扩展改」第 2 条）：`ProviderExtensionService` 新选项 `skillTrashDirectory`（`main.ts` 接的跟 Codex 技能同一个回收站），
  给了才让 `mutate({ kind: 'skill' })` 对这两家走 `mutateOwnSkill`：导入复制进 `~/.claude/skills` / `~/.grok/skills`（或项目里同名那层），移除重新扫一遍、只认直接放在它自己技能文件夹下的那份，挪进回收站。
  复制和挪动复用 `codex-extensions.ts` 拆出来的 `resolveSkillImportSource` / `skillImportTarget` / `copySkillImport` / `moveSkillToTrash`（不跟链接、单链接、大小和层数上限，I8），Codex 的 `importSkill` 改调同一套，行为不变。
  Grok 也读的 `~/.agents/skills` 跟 Codex 共用，Grok 那一格不给移除。能力里新加可选的 `capabilities.skill.install`，没给回收站时是 `false`，界面据此决定出不出导入按钮。
  Windows 跨盘挪进回收站的问题（#1357）这两家同样有，还在等真机。
- 界面去掉 `skills-import-unsupported` 那一行、「看怎么放」和教程里的 `skillImportTutorialExtra`；教程外壳 `navigate('tutorial', 'id#补充说明')` 的跳法留着，眼下没有调用方。
- 外接工具不挂「可更新」（`extensionShowsUpdatePill`），详情「更新状态」换成 `extensionUpdateStatus` 那句（Git 来源不写提交号）。
- 精选添加框能用的工具全是「未安装」时出「还没装能用它的工具」和「去首页安装」（`extensionNoToolInstalled`，`FeaturedPage` 新的 `onOpenHome`）；
  只装了 Codex 桌面端时插件弹窗那一格照旧叫「Codex CLI」（以前跟外接工具一样写成桌面端）。
- 装、加、删失败的错误以前只剩「命令执行失败（退出码 1）：claude」，命令行自己说的原因从没到过界面：新的 `extension-command-output.ts` 的 `withCommandOutput`
  把认得出的行（没有就最后三行，已脱敏，最多 240 字）接在「（命令输出：」后面，原错误挂在 `cause` 上；用在 `ProviderExtensionService.mutate` 和 Codex 的加外接工具、加插件、加市场。
  认法在新的 `extension-command-failure.ts`（渲染层可值导入，已登记 `valueImportable`）：缺 Git、连不上 github.com、`already exists` 三种，`operation-error.ts` 只在带着这个记号的话里认，配上 `registry/errors.ts` 新的 `gitMissing` / `githubUnreachable` / `nameTaken`。
