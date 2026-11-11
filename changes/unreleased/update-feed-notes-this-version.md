## 开发

- 更新清单（latest.yml、latest-mac.yml、Linux 那几份）的 `releaseNotes` 只带要发的这一版那一节，
  不带版本号那一行：`electron-builder.config.cjs` 的 `releaseInfo` 从 `releaseNotesFile` 换成
  `releaseNotes`，取自 `scripts/extract-release-notes.cjs` 新增的 `feedReleaseNotes`。原来整份
  release-notes.md（二十多万字、从 0.1.x 起）原样进清单，0.2.22、0.2.23 的版本页把前 20000 字塞成一整段、
  还接着前几版，「重启并安装」被挤到最底（yoyo 2026-11-10「清单改」）。老客户界面不用改就短下来；
  0.2.24 起的界面本来就把没有版本行的说明当成这一版、一条一行。首节对不上这一版（升级冒烟、测试包
  临时调高版本号）时照原来整份写进去；真发版首行必须等于版本号，由发布前置检查拦（P-14）。
