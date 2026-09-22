## 用户

- 安装或更新失败时，对话框里多了一颗「复制路径」：把这个工具的安装目录（还没装上就是它将要装到的目录）复制走，拿去加进杀毒软件的信任区，或者检查这个目录能不能写。路径同时显示在对话框里，剪贴板写不进去也能自己选中复制。
- 写不进安装目录时的提示改了说法：标题从「需要管理员权限」改成「写不进安装目录」，正文说明本工具按普通权限运行、不会提权，请检查这个目录的写入权限或杀毒软件。**不再提供「以管理员身份重试」**——那颗按钮此前没有接线，点了也不会有反应，而真去提权等于把安装换到另一个目录、另一套事务，不是「重试」。

## 开发

- A2 余项。`ToolStatus` 增加可选字段 `installTarget`：这个 CLI 装上去会落在哪个目录。未装时 `installDirectory` 为 null，而「复制路径」要回答的正是这一刻的问题。
- `electron/system-service.ts` 新增纯函数 `cliInstallTargetDirectory(provider, options)`，把 `installCli` 的落点选路重放一遍（托管 npm 布局优先，Grok 的 Windows 原生通道单列，其余落在当前 npm 全局根下），算不出来返回 null。`inspectCliTool` 里的 `resolveCliInstallTarget` 负责按平台与 `windowsExecutionMode` 决定传不传托管 prefix，并吞掉 ProgramData / HOME 解析失败——探测不该因为一个附带字段失败。
- `OperationFailure` 增加可选字段 `tool`，`perform(label, work, tool?)` 与卸载确认都会带上；目录本身由 `App.tsx` 在渲染那一刻用新的 `toolInstallDirectory(snapshot, tool)` 从当时的快照里取（`installDirectory ?? installTarget`），不缓存在失败对象里。
- `OperationActionId` 增加 `'copyPath'`，`actionIds` 收下「复制路径」；`operationErrorActions(failure, installDirectory)` 像过滤「重试」一样过滤它——没有目录就不出按钮。复制在对话框内部完成，不经 `onAction`，因此不会关掉对话框。
- `registry/errors.ts` 的 `permission` 条目改为 `{ title: '写不进安装目录', actions: ['复制路径', '查看日志'] }`，「以管理员身份重试」从目录里删除；`operation-error.test.ts` 加了一条断言钉住它不再出现。
- 路径只上屏、只进剪贴板：不拼进错误正文，不进 `runtime.jsonl`，不进诊断导出（I13）。
