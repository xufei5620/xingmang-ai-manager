## 用户

- 单个工具点「检查更新」时少等一下，不再每次都多跑一遍检测。

## 开发

- `inspectCliUpdate`（electron/system-service.ts）同 #729：只用 `findInstalledExecutable('npm')` 查 npm 路径，不再走 `inspectTool('npm')` 多起一个 `npm --version` 子进程；路径仍每次现查、不缓存。找不到 npm 时传下去的仍是 `null`，结果与之前一致。
