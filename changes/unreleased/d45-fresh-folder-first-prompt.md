## 开发

- 新手引导最后一步和首页「试试第一条命令」那句粘进去的话：要打开的是星芒刚建、还空着的项目文件夹时，
  换成让工具动手做个小网页（Claude Code 待办清单、Codex CLI 计算器、Grok CLI 番茄钟，字照汇总决定单 D45，
  新手流程 N4）。主进程 `starter-workspace.ts` 的 `isUntouchedStarterWorkspace` 只认 `XingmangProjects` 下
  星芒起的名字、只列这一层的名字（星芒放的 `AGENTS.md`、点开头的、`desktop.ini`、`Thumbs.db` 不算），
  判不准算不是；结果随配置摘要和打开结果的 `rememberedWorkspaceFresh` 带给界面，`opensUntouchedStarterWorkspace`
  按「打开」会落在哪个文件夹挑那句话。Codex 桌面端那句不变。
