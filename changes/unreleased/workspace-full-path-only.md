## 开发

- 工作目录只收完整路径（0.2.24 深查 IPC接口 第 1 条，I5 加固，不放宽任何校验、不改字、不加通道）：`cli:launch` 的 `parseWorkspace` 和 `settings:save` 存目录都走 `ipc/parsers/common.ts` 新的 `requiredWorkspacePath`，按本机平台只认完整路径（Windows 是盘符或网络共享路径，`\foo`、`C:foo` 这种要看当前盘的不收；Mac / Linux 是 `/` 开头），拒 NUL、限长。以前送来 `.`、`foo` 这种相对路径，工具会在主进程当前目录打开，`classifyWorkspace` 认不出来，「这个文件夹不建议打开」那一问被跳过。`cli:launch` 不带目录时回落的记住的目录同样过这道检查；带了却不是字符串的直接报「工作目录格式错误」，不再悄悄换成记住的目录。`settings:save` 收到「每次都提醒」的目录（系统文件夹、存密钥的文件夹）不存、留着原来那个，跟选择器的 `rememberWorkspace` 共用 `workspace-guard.ts` 新的 `shouldRememberWorkspace`：设置页「更换」选到这种目录点了「仍然打开」，以前选择器不记、设置页紧接着又照存了。
