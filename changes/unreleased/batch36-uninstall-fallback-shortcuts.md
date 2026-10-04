## 用户

- Windows 上卸载星芒以后，桌面和开始菜单里不会再剩下点不开的星芒图标；之后重新安装、换了安装文件夹，桌面图标也能照常出现。
  以前只在装了安全软件、或者公司电脑不让软件往所有人共用的桌面放图标的电脑上会碰到。

## 开发

- 第三十六批 C：`build/installer.nsh` 新增 `un.xingmangRemoveFallbackShortcuts`，`customUnInstall` 在真卸载（`${IfNot} ${isUpdated}`）
  里、卸载清理之后调用：按所有用户安装时切到当前用户，删掉 `customInstall` 补建的 `$DESKTOP\${SHORTCUT_NAME}.lnk` 和开始菜单里的
  `${SHORTCUT_NAME}.lnk`（定义了 `MENU_FILENAME` 时删文件夹里那个，再不带 /r 地 RMDir 那个文件夹），再用
  `xingmangRestoreShellVarContext` 切回。electron-builder 的卸载模板只删 `setLinkVars` 在 all 上下文里算出的 `$oldDesktopLink` /
  `$oldStartMenuLink`，补建在当前用户那里的一直没人删；`customInstall` 又只在路径上没有文件时才补，指向旧文件夹的图标还在就不补。
- 跟模板删公共图标的做法一致：带 `--keep-shortcuts` 不删，`DO_NOT_CREATE_*` 关掉的那一类跳过，删之前先 `WinShell::UninstShortcut`。
  只删这几个固定路径，不用通配符、不带 /r。升级（--updated）时不跑：新版不补图标，这时删了图标就真没了。卸载详情里不加新句子。
- `scripts/windows-installer-shortcuts.test.cjs` 加三条：卸载删的路径与 `customInstall` 在当前用户那里补建的逐条对上（顺手建的文件夹同理）；
  只在真卸载里调，守着 `--keep-shortcuts` 和 `DO_NOT_CREATE_*`，函数只进卸载程序那一遍；切到 current 以后每条路都切回。
  `windows-installer-uninstall-cleanup.test.cjs` 那条正则放宽到 isUpdated 守卫里可以跟着别的调用。
- `windows-uninstall-smoke.yml` 加一步 `scripts/windows-uninstall-shortcuts-smoke.ps1`：真装真卸。先用 icacls 拒绝所有人往公共桌面和
  公共开始菜单里加文件，让安装程序自己把图标补建在当前用户那里，旁边再复制一个别的名字的；覆盖安装、带 --updated 的升级各一次后都还在；
  真卸载后补建的两个没了、别的名字那个还在；再装到另一个文件夹，两个图标又补出来，再卸载又没了。最后把两个文件夹的权限改回去。
- 这次不管的两种：普通账号输别的管理员密码代为安装和卸载（补建、删除都在那个管理员那里，两头对称）；不先卸载、直接拿新安装包覆盖安装
  又换了文件夹（旧卸载程序带 --updated 跑，不删；新安装程序看见旧图标在，也不补）。
