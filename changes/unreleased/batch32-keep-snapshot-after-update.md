## 用户

- 星芒更新完第一次打开时，首页先摆出上次检测到的工具，不用再对着「正在检测本机工具」空等这一轮检测做完。

## 开发

- 第三十二批 A：`electron/system-snapshot-cache.ts` 不再因为 appVersion 不同就扔掉上次的检测结果（#403 起换了版本就不认，
  每次更新后的第一次打开，首页「你的工具」都只剩一条进度条）。格式版本号对、形状校验过就认，不管是哪一版写的。
  别的版本写的文件，每家 CLI 去掉 `versionAdvice`、`revertVersion`，`updateAvailable` 记 false、`updateState` 记 unknown
  （`withoutVersionVerdicts`）：这几项是上一版按它自带的推荐版本名单下的判断，而首页先摆上次结果的那几秒里「更新」
  「更新到推荐版本」能点，点下去版本号原样交给主进程、按点名的版本装，新版本的名单换了推荐版本就会装错。同一版本写的照旧原样用。
- 新加类型钉子 `SnapshotShapePins`：快照每一层（SystemSnapshot、ToolStatus、CliStatus、DesktopAppStatus、
  NetworkLocationStatus、CliUninstallCapability）的必填字段连同类型照抄一份，加、删、改必填字段（包括必填改可选）
  `npm run typecheck` 就过不去，注释写明改清单的同时把 `SYSTEM_SNAPSHOT_CACHE_VERSION` 加一。按 tag 比过 v0.2.10～v0.2.14
  和 main，必填字段一个没变，格式版本号保持 1。`system-snapshot-cache.test.ts` 用 `@ts-expect-error` 钉住钉子本身真会报错。
