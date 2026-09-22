## 用户

- 新版本下载好之后，从托盘「退出」或者按「直接退出」关掉软件时会问一句要不要顺手装上：
  选「安装并退出」就装完再关，选「先退出，下次再装」照旧退出，安装包一直留着，下次退出再问。
  更新没下载好、或者还有 CLI 正在安装时都不会问。

## 开发

- 更新处于 `downloaded` 时的退出确认：`window-lifecycle.ts` 的 `confirmQuitWhileBusy` 改名为
  `confirmQuit`，返回值加 `'install-update'`，并新增可选的 `installDownloadedUpdate`；安装器在
  `quitting` 置位之后、`options.quit()` 之前拉起，免得它自己发出的退出又被这套流程拦一次。
- `quit-blocking-tasks.ts` 新增 `resolveInstallableUpdateOnQuit`：只认 `downloaded` 且无 `error`
  的非开发态快照——带 `error` 的 `downloaded` 说明安装器已经启动过并失败，`requestInstall` 不会
  再跑第二遍。`main.ts` 把「安装在跑」和「更新已下载」排进同一个回调，一次退出最多弹一个框。
- `updater.ts` 的 `autoInstallOnAppQuit` 保持 `false`，安装仍然只由用户点头触发。「每次询问」
  那条路径和 Windows 关机 / 注销（`session-end`）照旧不问，与 #331 一致。
