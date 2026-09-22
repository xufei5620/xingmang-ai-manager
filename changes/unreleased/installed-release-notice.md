## 用户

- 更新装完、软件重新打开后，右上角会出现一张小卡片：「已更新到 x.y.z」，下面列出这一版最主要的几项改动，点「知道了」就收起，不挡任何操作。更新页在没有新版本可下载时，也会逐条列出当前这一版的全部改动。这些内容随安装包一起带着，断网也能看到。普通重启和新装都不会出现。

## 开发

- 新增 `scripts/bundle-release-notes.cjs`，接在 `compile:runtime` 最后一步：把 `release-notes.md` 顶节（第一行必须等于 `package.json` 版本号，否则写 `notes: null`）逐条写进 `dist-electron/release-notes.json`，随 `files` 进 app.asar，不改 `electron-builder.config.cjs`。`scripts/verify-packaged-hardening.cjs` 新增 `inspectPackagedReleaseNotes`，出包时核对这份文件存在、版本与包内 `package.json` 一致、格式有效。
- 新增 `electron/installed-release.ts`：`last-run-version.json`（safe-local-data 原子写，读坏降级为没有记录）记住上次运行的版本；版本升高才算「刚更新」，降级不算；没有记录时以运行日志或 settings.json 是否存在区分老用户与新装（第一个带这项功能的版本也能提示）。结果经 `UpdaterRuntime.installedRelease` 进 `UpdateSnapshot.installedRelease`（可选字段，缺省 = 旧行为）。
- renderer-v2：`startup-notice.ts` 新增 `updatedNotice()` 与 `releaseNoteHeadline()`（启动提示 id `updated`，不记错误日志；列前三项改动的开头半句；`StartupNoticeAction` 新增 `dismiss` 一种，按钮即「知道了」，此时不再显示关闭叉）；`features/app/release-notes.ts` 的 `releaseNotesSection()` 决定更新页右侧卡片说待下载版本还是当前版本。`docs/RELEASING.md` 补一行「先改好标题再编译」。
