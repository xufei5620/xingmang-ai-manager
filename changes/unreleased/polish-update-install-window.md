## 开发

- `electron/main.ts`：Mac 闲时装新版本（#1380）装到一半用户从菜单栏、系统通知点开了窗口，装好重新拉起时窗口照常出来。
  之前撤回 `backgroundInstall` 记录的那条只挂在窗口第一次显示上（`once('show')`），管的是开机自启那次的后台装；闲时装多半发生在
  窗口开过又缩回去以后，第一次显示早过了，于是重新拉起的那次被当成后台装的拉起、窗口不出来。现在挂在每一次显示上
  （`dropBackgroundInstall` 没有后台装记录时什么也不做）。0.2.22 发版前回归检查第 5 条。
- `electron/auto-update-install.ts` 新增 `memoizeUnattendedInstall`：跳框器每两秒问一次「装的时候弹不弹窗口」（`canInstallUnattended`），
  每问一次都解一次符号链接、试两处能不能写，全是同步读盘；同一种装法一分钟内只算一次，装法换了就重算。0.2.22 性能体检第 7 条。
- `electron/app-settings.ts`：`readAppSettings` 给主文件加了一层按 lstat 身份（设备号、inode、大小、mtime、ctime）校验的读缓存。
  主窗口每次 resize 和 `platform/renderer-v2.ts` 每次重算缩放都同步读 `settings.json`，拖窗口时一秒几十次，每次都是
  open + 三次 stat + realpath。只缓存主文件完整校验读成功的结果，不是普通文件、有第二个硬链接、stat 读不出的照旧走完整校验；
  自己的保存走 rename，inode 必变；备份与缺省不缓存，主文件坏了下一次照旧落到备份。0.2.22 性能体检第 8 条。
