## 开发

- Windows 画布项目文件换成自己的文档图标（深查 IC-10，2026-11-13 yoyo 看过预览回「改」）：`win.fileAssociations` 加
  `icon: 'canvas-project.ico'`。原来没配，electron-builder 让文件类型借用程序图标（`"$appExe,0"`），桌面上作品文件跟星芒的快捷方式一模一样。
  图标是白纸折角、右下角一颗 standard 母版的星芒，不加字，16–256px 十档逐档画（`scripts/generate-canvas-project-icon.mjs`，产物
  `build/canvas-project.ico`，只给安装程序用，不进 app.asar）。安装时拷到安装目录的 `resources` 下，`DefaultIcon` 指过去；卸载随
  `resources` 一起删。`customInstall` 本来每次安装都发 `SHChangeNotify(SHCNE_ASSOCCHANGED)`，升级后不用重启就换图标。
- `windows-installer-file-association.test.cjs` 钉住配置、ICO 的十档结构和「是白纸不是深蓝方块」，以及 electron-builder 仍读这个 `icon`；
  `windows-file-association-smoke.ps1` 在真装和升级后核对 `DefaultIcon` 和图标文件。
- Linux 没跟着改：electron-builder 26.15.3 写 MIME 包时把图标写死成 `x-office-document`（`LinuxTargetHelper.computeMimeTypeFiles`），
  不读 `fileAssociations[].icon`，Linux 上作品文件显示的是系统通用文档图标，不会跟星芒混。要换专用图标得改 deb 的图标和 MIME 包写法，
  跟 Linux 程序图标只有一档（Linux.md G1）一起做。Mac 系统自己给文件套白纸样式，不用改。
