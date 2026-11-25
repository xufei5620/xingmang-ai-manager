## 开发

- Antigravity 命令行「打开」时记住的项目文件夹已被删除或改名：以前主进程那句「项目文件夹不存在，请重新选择」直接进错误框，「重试」拿的还是那个不在的文件夹，怎么点都打不开。现在跟 Claude Code、Codex 那几张卡一样（`useToolLaunch` 的 `launchRemembered`）先提示「上次使用的目录已不存在，请重新选择。」再弹选择窗口，用选好的那个接着开（`antigravity.ts` 的 `openAntigravityCliIn`，认法同 `isMissingWorkspace`）；从选择窗口选好以后重读一次配置（`refreshSavedConfig`），首页手上记着的文件夹换成新选的，下次点「打开」直接进它，「选择其他文件夹…」选过的也一样。夹具加 `?antigravityWorkspaceGone`，`app-check.mjs` 加一条浏览器回归。
