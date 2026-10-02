## 开发

- 安装 / 更新前的归属确认 `assertNpmChannelOwnsCli` 与卸载 `uninstallCliOperation`（electron/system-service.ts）同 #737：只用 `findInstalledExecutable('npm')` 查 npm 路径，不再走 `inspectTool('npm')` 多起一个 `npm --version` 子进程。两处本来就只用 `.path`，找不到 npm 时传下去的仍是 `null`，结果不变。
