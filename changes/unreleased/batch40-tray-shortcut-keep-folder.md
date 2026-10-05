## 用户

- 从托盘菜单「已安装的工具」里点 Claude Code、Codex CLI、Gemini CLI、Grok CLI，或者按 Ctrl + 1～5（Mac 上是 Command + 1～5）
  打开它们，现在和首页的「打开」按钮一样，直接在上次用的文件夹打开，不再每次弹出选文件夹的窗口。上次的文件夹被删掉或改了名，
  会先提示一句，再让你重新选。想换文件夹，点首页「打开」旁边的小箭头「换一个目录」。

## 开发

- 第四十批 A：托盘「已安装的工具」（`main.ts` 发 `window:launch-tool`）和 Ctrl / Command + 1～5 交给 `requestLaunch` 的只有工具名，
  不带文件夹，`launch()` 拿不到 `remembered` 就弹 `chooseWorkspace`。#702 只给首页那颗按钮接上了「记住上次的文件夹」
  （`Home.tsx` 先用 `launchWorkspaces` 挑好再交出去），这两个入口没跟上；第七批「看过但不列」以为托盘已经覆盖，那句不对。
- `App.tsx` 加 `requestLaunchInLastWorkspace`：Codex 桌面端照旧直接 `requestLaunch`；四个命令行工具先读 `toolsApi.recent()`
  （首页那份 60 秒缓存，读不到当没有记录），按 `launchWorkspaces(记录, providerFor(id), snapshot.config.rememberedWorkspace)[0]`
  挑文件夹，挑得到就走 `launchRemembered`（文件夹不在了提示「上次用的目录已经找不到了，请重新选择。」再弹选择框），挑不到照旧弹。
  读记录那一下换了账号就不接着打开，同 `launch()` 的 epoch。不新写字，不加 IPC 通道，主进程不改。
- 测试：`testing/app-check.mjs` 加三条：托盘和 Ctrl+2 用首页按钮上的文件夹、没记录也没选过的 Ctrl+5 照旧弹、托盘开 Codex 桌面端不变；
  首页选过一次后托盘和 Ctrl+1 不再问，记录读不到时也一样；记住的文件夹不在了先提示再弹。夹具 `launchCli` 加 `?workspaceGone`
  （打开 `C:\work\my-app` 时报主进程那句「工作目录不存在，请重新选择」）。三条在没改 `App.tsx` 时都红。
