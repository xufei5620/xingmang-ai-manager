## 用户

- 升级时旧文件被占用，改成中文提示，可一键重试。

## 开发

- `build/installer.nsh` 接管 `customUnInstallCheck`：旧版本的卸载程序（`--updated` 静默）挪不走旧文件、把挪开的放回去并以 2 退出时，
  模板只弹没翻译的「Failed to uninstall old application files. Please try running the installer again.: 2」就 `Quit`
  （10-27 yoyo 真机升级撞到，重启后再装就好）。现在弹中文的「重试 / 取消」：重试先用系统目录里的 `taskkill.exe /F /IM`
  强关星芒（模板在 PowerShell 用不了时按整台电脑安装的那句不带 `/F`），再跑一遍旧卸载程序；取消跟模板一样以 2 退出，旧版本原样。
- 清单里有、安装目录里已经没了的条目不再卡住升级：新安装程序在跑旧卸载程序前先把这些项从 `InstalledEntries` 删掉，
  新卸载程序的 `un.xingmangMoveAside` 也把「本来就不在」算成挪开了。以前这种情况每次升级都弹同一个英文框，重启也没用。
- `windows-uninstall-smoke` 加 `scripts/windows-upgrade-blocked-smoke.ps1`：在 Windows runner 上真装最新正式版再拿这次的包升级，
  覆盖「清单项已没」与「文件被占着 → 中文框 → 取消原样 / 放开后重试装上」。
