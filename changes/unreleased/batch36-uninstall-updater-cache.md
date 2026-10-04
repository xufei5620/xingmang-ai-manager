## 用户

- Windows 上卸载星芒以后，C 盘里不再留着星芒自己的安装包。以前卸载后会剩下一到两份，每份都有整个安装包那么大。
  Mac 上在设置里点「卸载星芒」，也会一起删掉已经下好的更新。只删安装包，工具、Key 和设置照旧留着。

## 开发

- 第三十六批 B：electron-builder 的安装程序每次安装都把自己拷到 `%LOCALAPPDATA%\xingmang-ai-manager-updater\installer.exe`
  （模板 `installer.nsh` 的 `APP_INSTALLER_STORE_FILE`，留作增量更新的底），electron-updater 把下好的新版放在同一目录的
  `pending` 里；Mac 上是 `~/Library/Caches/xingmang-ai-manager-updater`（`pending` 加一份留作增量底的 `update.zip`）。
  卸载模板一次都不碰 `LOCALAPPDATA`，卸载清理以前也不管它。
- `uninstall-cleanup.ts` 加 `updaterCacheDirectoryName`、`resolveUpdaterCacheDirectory`（照 electron-updater 的
  `getAppCacheDir`：Windows 用 `LOCALAPPDATA`，没有就用用户目录下的 `AppData\Local`，只认带盘符的完整路径；Mac 用
  `~/Library/Caches`）和 `clearUpdaterCache`。删法是把原来的 `removeChatHistoryTree` 抽成带名字、带层数上限的
  `removeOwnedTree`，聊天记录和更新缓存共用：每一级过 `assertNoReparseComponents`，文件走 `removeSafeDataFile`，碰到符号链接、
  目录联接和多链接文件就留在原地、其余照删（I8），不用整棵删。聊天记录那半的行为和报告文字不变。
- Windows：`runUninstallCleanup` 在代理还原之前删（还原可能等到超时，没有代理记录时也要删到）；删不掉只往报告里写一行
  `update cache: …`，不加退出码，卸载程序给客户看的几句不变。另一个管理员账号卸载（退出码 32）时照旧什么都不动；
  升级安装带 `--updated` 不跑卸载清理，不会删到正在用的安装包。`startUninstallCleanup` 多一个可替换的参数，测试里不碰跑测试
  那台电脑上真的更新缓存。
- Mac：`macos-uninstall.ts` 在程序确实挪进废纸篓之后、退出之前删，挪不动就不删（下好的新版还能装）；没删掉只记日志，
  不算进 `leftovers`，提示不变。`main.ts` 接上这一步。
- `scripts/windows-uninstall-cleanup-smoke.ps1`：每次装完先查 `installer.exe` 确实拷进了更新缓存，每轮清理前放一份假的
  下好的更新，清理后查整个目录没了；第一轮直接清理时缓存里另放一个目录联接，查联接和它指向的文件原样留着、旁边的照删，
  清理退出码仍是 0。
