## 开发

- D17（0.2.24 深查 `权限和写失败.md` PW-10，yoyo 11-10「按照你的推荐做」）：从星芒打开命令行工具前在项目文件夹里试写一次，
  写不进去不拦，打开后首页那条提醒说「这个文件夹只能看不能改，AI 改不了里面的文件，建议换一个。」。
  Mac、Linux 在 `provider-launch-service.ts` 的 `launchProviderOperation` 里试写（敏感目录判定之后、写信任之前，
  `documents-fallback.ts` 新增 `shouldNoteReadOnlyWorkspace`：普通文件夹和桌面、文稿、下载才试，主目录、盘根、系统目录不试）；
  Windows 照旧在 `ipc/handlers/launch.ts` 的 `launchIfWritable` 试那一次，权限类（EPERM / EACCES）照旧弹「这个文件夹不让写入」，
  `inspectWorkspaceWritable` 新分出的 `read-only`（EROFS：光盘、写保护的 U 盘、只读挂载）不再悄悄打开，改为同样打开后提醒。
  结果经 `CliLaunchResult.workspaceReadOnly` 带回渲染层，`launch-notice.ts` 的 `launchWarning` 出这句（跟项目设置盖过账号那句
  同时有时前后接着说），首页和记录页「接着聊」都用它。日志沿用 `workspace.write-check`（结果与耗时，不记路径）。
  新增测试注入项 `SystemServiceOptions.probeWorkspaceWritable`；没加 IPC 通道。
