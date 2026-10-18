## 开发

- 主进程判断版本新旧只留一份比较：`electron/versions.ts` 的 `compareVersionNumbers` / `compareVersionsBy`，
  更新器（`updater.ts`）、上次运行记录（`installed-release.ts`）、Node 运行时与 Python 运行时的发布索引都改用它
  （#1073 第 3 条 b）。各处认什么写法照旧，分别是 `versions.ts` 里的 `parseUpdateVersion`、
  `parseInstalledReleaseVersion`、`parseNodeReleaseVersion`、`parsePythonReleaseVersion`，改动前先用测试把每一处
  的认法钉住（预发布号、前缀 v、空白、前导零、位数、超大数字）。Codex 桌面端的四段包版本比较
  （`codex-desktop.ts` 的 `compareWindowsPackageVersions`）在镜像和离线包那条链上，按 AGENTS 第 7 节不动。
