## 开发

- 界面文案正式化·教程正文补改（补漏第二批里记下的「还剩下的」，口吻规范同前几批，逐条对照在
  `/mnt/project-files/界面文案正式化/教程正文-改了哪些字.md`）：`registry/tutorials.ts` 里第 10 批和补漏第二批都没列到的
  偏口语正文改成书面口吻，共 232 处（「点「…」」→「点击「…」」、「…里」→「…中」、「装」→「安装」、「不要」→「请勿」、
  「知道…」→「已了解 / 已确认…」等），另有 9 处漏掉的步骤标题和按钮、教程配图的标题和说明 27 处（`TutorialIllustration.tsx`）。
  只改字，不改含义和步骤，不动版面和行为。
- 「记录」一章的「工作文件夹」跟记录页表头对齐成「项目文件夹」；「设置 › 版本更新」里「怎么清理」那段用的是同一句
  `updateDiskCleanupDetail`，跟着一起变。
- Linux 版教程的删句表 `linuxRemovedTutorialSentences` 里四句跟着换成新句子，不然 Linux 版会漏出「桌面端」「Claude Desktop」「WSL」。
- 照旧的：客户照抄发给 AI 的示例提问、教程搜索词、引用界面上按钮名和选项名的「」里的字；插件页自己那两行分组小字
  「只能装进 Claude」「只能装进 GPT」不在教程里，这次没动。
- 断言旧字的用例（`tutorials.test.ts`、`pages-maintenance.test.ts`、`testing/app-check.mjs`）换成新字。
