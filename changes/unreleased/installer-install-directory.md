## 用户

- Windows 安装时不再允许把程序装进已经有别的文件的目录：选到这种目录会提示换一个空目录，
  或者选它的上一级让安装程序自己新建一个；覆盖安装旧版本照常可行。
- 卸载时只删安装程序自己装进去的文件，安装目录里你自己放的东西会保留，目录也不会被整个删掉。
  用软件生成的图片默认就存在安装目录的 `output` 里，以前卸载会连它们一起删，现在不会了。

## 开发

- `build/installer.nsh` 新增目录页守卫：顶层定义 `MUI_PAGE_CUSTOMFUNCTION_LEAVE`，在 `customHeader`
  里实现 `xingmangVerifyInstallDirectory`。它按 electron-builder `instFilesPre` 的同一条规则先补出
  真正会被写入的目录（不然选 `D:\Downloads` 会被误拒），目录里有本程序主 exe 或卸载程序时直接放行，
  否则非空就弹中文提示并 `Abort` 停在目录页。`electron-builder` 调 makensis 带 `-WX`，一旦将来目录页
  之前多出别的 MUI 页面把这个 define 吃掉，该函数会变成未引用函数让打包当场失败，守卫不会静默失效。
- `build/installer.nsh` 新增 `customRemoveFiles`，替换掉 electron-builder 默认的 `RMDir /r $INSTDIR`。
  `customInstall` 收尾时把安装目录的顶层条目写进注册表 `${INSTALL_REGISTRY_KEY}\InstalledEntries`
  （`Count` 最后写，写不全就当作没有清单），卸载时只删清单里的条目，最后用不带 `/r` 的 `RMDir` 收尾，
  目录里还剩别的东西就保留。更新器拉起的 `--updated` 路径仍复用上游的 `un.atomicRMDir` / `un.restoreFiles`
  做原子改名与失败还原，只是范围收窄到清单条目。读不到清单（老安装程序装的）时沿用旧做法。
- 新增 `scripts/windows-installer-install-directory.test.cjs`，钉住上面两条；
  `scripts/windows-installer-shortcuts.test.cjs` 里"永不删除"的断言收窄到 `customInstall` 一段。
