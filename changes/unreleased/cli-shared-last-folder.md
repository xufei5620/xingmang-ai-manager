## 用户

- 首页「打开」记住你上次选的文件夹，四个命令行工具共用：在 Codex 里选过一次，第一次打开 Claude Code、Gemini、Grok 时按钮直接写「打开 my-project」，点了就开，不再弹出选文件夹的窗口；打开后没聊就关掉，下次也不会再问。想换的点按钮旁边的小箭头「换一个目录」或「新建项目文件夹并打开」。桌面、下载、用户文件夹这类范围太大的地方不会被这样记住，打开时照旧先问。

## 开发

- `workspace-guard.ts` 新增 `resolveRememberedWorkspace`：设置里存的 `workspace` 不是主目录（从没选过时的默认值，另按 `os.homedir()` 再核一遍）、也不是任何敏感目录时才算「记住的文件夹」。`AppConfigSummary` 新增可选字段 `rememberedWorkspace`（`config:get` 带出，不加通道）。
- 渲染层 `recent-workspaces.ts` 新增 `launchWorkspaces`：这个工具有会话记录时照旧用记录，一条都没有时退回 `rememberedWorkspace`。首页按钮与下拉改用它；`App.tsx` 在目录选择器选完后重读一次配置，按钮马上换成新文件夹。
- 记住的文件夹后来被删掉时，沿用 N7 的退路：提示「上次用的目录已经找不到了」并弹选择器。
