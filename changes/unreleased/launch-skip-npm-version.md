## 用户

- 点「打开」启动工具时少等一下，不再每次都多跑一遍检测。

## 开发

- `launchProviderOperation`（electron/system-service.ts）打开 CLI 前只用 `findInstalledExecutable('npm')` 查 npm 路径，不再走 `inspectTool('npm')` 多起一个 `npm --version` 子进程；路径仍每次现查、不缓存，装 / 卸 / 换 Node 后不会拿到旧答案。第二十五批候选 ④。
