## 用户

- Mac 上设置 → 隐私与数据多了「卸载星芒」：先收回星芒写进 Claude Code、Codex、Gemini CLI、Grok 里的提醒设置，再把星芒移到废纸篓并退出，卸完在终端里用这些工具不再多出红字。密钥和工具设置都留着；可以顺手勾「同时清除登录记录和聊天记录」「连同星芒替你装的命令行工具一起删」，两项默认都不勾。

## 开发

- 新增 `window:uninstall-app` 通道与 `electron/macos-uninstall.ts`（只在 macOS 打包版可用）：安装队列空闲才动；按「修好它」同一份备份后复用 `removeCliHooksFromConfigs` 收回四家钩子，关开机自启，勾了才删 `~/Library/Application Support/XingMangAI`（根目录是链接时拒绝），`shell.trashItem` 移走 `.app`；从磁盘映像或 App Translocation 副本运行、或废纸篓拒绝时不退出，界面提示自己拖。清登录记录排在退出清理（断开加速、聊天记录落盘）之后，免得被写回。Windows 那一行不变。
