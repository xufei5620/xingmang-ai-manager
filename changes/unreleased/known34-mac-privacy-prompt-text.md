## 用户

- Mac 上星芒第一次要读「文稿」「桌面」「下载」、U 盘、共享盘里的东西时，系统弹的那个询问框下面多一行星芒自己的说明，
  告诉你为什么要读（比如 AI 画的图存在“文稿”里的 XingmangAI 文件夹）。装上这一版才看得到。

## 开发

- 已知34：`electron-builder.config.cjs` 的 `mac.extendInfo` 加五项隐私说明（`NSDocumentsFolderUsageDescription`、
  `NSDesktopFolderUsageDescription`、`NSDownloadsFolderUsageDescription`、`NSRemovableVolumesUsageDescription`、
  `NSNetworkVolumesUsageDescription`），`scripts/macos-build-config.test.cjs` 钉住各种打包方式都带。要 Mac 真机看。
