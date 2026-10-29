## 开发

- #1407 P2-1（红队拍板项第 4 条，yoyo 10-29 回「按推荐」）：窗口缩到托盘后遥控照样开着，设置页却写「关掉星芒就断开」，
  托盘里只有一行点不了的灰字。`application-tray.ts` 快照加 `remoteControlOn`、选项加 `onRemoteControlOff`，有渠道开着时
  在挡睡眠那行灰字下面出一项能点的「关掉手机遥控」（灰字在说别的事时也在）；`CodexRemoteService.disableAllChannels()`
  按设置页点关的同一条路把开着的渠道逐个停掉，手机上收到同一句「手机遥控已在电脑上关闭。」。`main.ts` 在遥控状态回调里
  只在 `hasEnabledChannel()` 翻转时重建托盘菜单，点击另记一条 `remote.tray-off`。设置页 `remoteSwitchHint` 换成批过的原句；
  用户那条并进 `011-codex-remote-feishu.md`（原来写的「关掉星芒」也改成「退出星芒」）。
