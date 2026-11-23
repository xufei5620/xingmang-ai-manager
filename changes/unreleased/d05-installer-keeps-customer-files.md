## 用户

- 升级或卸载星芒时，将保留您自行放入安装文件夹的文件。

## 开发

- 11-18 复核 D05（0.2.25 总单 #41）：Windows 安装程序收尾时把安装目录里看到的顶层条目全记进清单，客户或管理员自己放进去的
  文件被当成软件文件，下一次升级就被旧卸载程序挪走删掉。现在 `build/installer.nsh` 的 `xingmangRecordInstalledEntries`
  只记安装包自己带的条目和卸载程序，名单由 `electron-builder.config.cjs` 的 afterPack 按 win-unpacked 现场写成
  `build/installer-package-entries.nsh`（`scripts/windows-installer-package-entries.cjs`，不进仓库，缺了安装程序编译失败），
  清单另记 `Format=2`。从没有 `Format` 的旧清单升级时，`customInit` 先把不是安装包自己的项划掉
  （`xingmangForgetForeignInstalledEntries`），旧卸载程序就不再删它们；代价是旧版本带过、这一版不带的软件文件会留在目录里。
  卸载冒烟新增 `scripts/windows-upgrade-user-files-smoke.ps1`：放进客户文件后连升两次再卸载、以及从记了客户文件的旧清单升级，
  客户文件都要在。
