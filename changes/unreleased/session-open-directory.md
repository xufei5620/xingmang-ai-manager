## 用户

- 记录页每条记录和首页「最近」卡多了「打开文件夹」：一下就能在资源管理器 / 访达里
  打开这条对话当时所在的项目文件夹，不用再自己复制路径。文件夹已经被删掉或搬走的
  那一条，按钮是灰的并说明原因。

## 开发

- 第七批候选 8。新通道 `provider-sessions:open-directory` / `openProviderSessionDirectory`
  （三份表同步，T1）：入参只有会话 id，工作目录由主进程的
  `ProviderSessionsService.resolveWorkspace` 从会话索引里取，渲染层不传任意路径。
- 新模块 `electron/session-workspace.ts` 的 `resolveOpenableSessionWorkspace`：必须是绝对
  路径、跟随链接后必须是目录，否则不交给 `shell.openPath`（`cwd` 若被改成一个可执行文件，
  openPath 会去运行它）。刻意不照搬 `config-directory.ts` 的「拒绝任何 reparse 组件」——
  那是给我们自己写出来的配置目录定的规矩，用户的项目目录本来就可能落在联接下面，
  与旁边「接着聊」的目录判断（`workspaceDirectoryExists`）对齐。
- 渲染层：`pages-management.tsx` 记录行按钮走 `useOperation`，`Home.tsx`「最近」卡走
  `toolsApi.openSessionDirectory` + toast；两处都在 `cwdExists === false` 时置灰。
