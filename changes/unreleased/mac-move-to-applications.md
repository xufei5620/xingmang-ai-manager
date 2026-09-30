## 用户

- Mac：没把星芒放进「应用程序」就直接打开时，提示框多了一颗「移到「应用程序」并重新打开」，点一下星芒会自己搬过去再打开，不用再退出、自己拖、再重开。搬不动时会说清原因，照旧可以手动拖或先继续用。

## 开发

- `electron/macos-install-location.ts`：首个提示改为「移到「应用程序」并重新打开 / 仍要继续 / 退出」，按钮与含义用 `choices` 一一对应；新增 `moveMacosAppToApplications`（包 `app.moveToApplicationsFolder`，两种同名冲突都按 Electron 默认处理并记下是哪种）与 `buildMacosMoveFailureNotice`（取消授权 / 复制失败时的大白话原因，英文诊断只进日志）。
- `electron/main.ts`：搬成功即停止本次启动交给 Electron 重开；新增日志 `app.install-location.moved` / `.move-failed` / `.move-cancelled`。
