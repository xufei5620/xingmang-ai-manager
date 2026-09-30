## 用户

- Windows 上打开工具前，会先试着往选好的文件夹里写一下。写不进（常见是 Windows 安全中心的「受控文件夹访问」或安全软件的文档保护开着）时先说一句，给「换到能写的位置」「照常打开」「先不打开」三个选择，不会再打开后 AI 说改了文件却什么都没改。能写的文件夹照旧直接打开。

## 开发

- 第二十二批 5。`documents-fallback.ts` 新增异步探针 `probeDirectoryWritable`（随机名 + `wx`，同同步版，I8）、`shouldCheckWorkspaceWritable`（只 Windows；普通目录与文档 / 桌面 / 下载，主目录、盘根、系统、配置目录这些选的时候已提醒过的不探）、`inspectWorkspaceWritable`（只有 EPERM / EACCES 算 denied，其它错误和 3 秒超时算 unknown 照常打开）、`buildWorkspaceNotWritablePrompt`。
- `ipc.ts` 的 `cli:launch` 在敏感目录那一问之后、`launchProvider` 之前调 `launchIfWritable`：主进程原生提示框，「换到能写的位置」复用 `createStarterWorkspaceOrExplain`（建不成回到选择器），续接对话只给「先不打开 / 照常打开」，不打开时返回 `{ declined: true }`。runtime.jsonl 记 `workspace.write-check`（结果与耗时，不记路径）。没加 IPC 通道，渲染层没动。新增测试注入项 `IpcRegistrationOptions.workspaceWriteCheck`。
- 受控文件夹访问报 EPERM 还是 EACCES、是否放行建文件却拦写入，没在 Windows 真机上核过（推测，两个码都认）。
