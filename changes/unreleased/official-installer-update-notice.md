## 用户

- 「工具有新版本」的系统通知只提醒星芒能一键更新的工具。用官方安装器或别的方式装的那份在星芒里没有「更新」按钮，以前也会弹「回到星芒就能逐个更新」，点回来找不到地方更新。

## 开发

- 第三十一批 B 第二块：`update-notice.ts` 新增 `inAppToolUpdates`，`App.tsx` 的 `cliUpdate` 通知（事件编号、是否提醒过、记下已提醒）改用它，
  跳过 `isExternallyManagedInstall` 为真的安装（官方安装器 `native`、其他来源 `path`）。侧栏角标与首页「N 个有更新」照旧按 `pendingToolUpdates` 数全部。
- `update-notice.test.ts` 钉住通知与角标各数哪些；`app-check.mjs` 在开机第一轮检测落地后核对：npm 装的那份照常通知，官方安装器装的那份不通知。
