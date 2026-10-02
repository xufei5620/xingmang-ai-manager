## 开发

- Linux 版自动更新（客户端，出 Linux 版拆分第 ⑧ 步，摸底明细 updater 区 U1/U2/U4/U6/U8）。Linux 还没对外发，这条不进
  更新说明。
- 只有 .deb 装的能自动更新（读 `resources/package-type`，`electron/linux-deb-update.ts`）：下载后照旧核对 SHA-512，
  装这一步不交给 electron-updater 的 DebUpdater（shell 拼 `pkexec bash -c 'dpkg -i'`、失败以 root 跑
  `apt-get -f -y`），而是用固定路径、归 root 的 `xdg-open` 把安装包交给系统安装程序，软件随即关掉；星芒全程不提权。
  打不开时替客户打开安装包所在的文件夹。Linux 从不在打开或退出时自动装，退出时只问一句。
- 不是 .deb 装的（AppImage、解包运行）更新器直接停在 disabled、更新页给「打开下载页」，不再永远卡在「正在检查」；
  electron-updater 返回 null 且没发任何事件时报 `UPDATE_INACTIVE`，Windows、Mac 打包版不会走到这一步。
- 状态文件的最低版本在 Linux 上只在更新目录真给了够格的新版本时才拦（`resolveGatedRequiredVersion`），Linux 更新包
  没上架时不会把客户关在门外；分批放量的豁免仍按「低于最低版本」算。Windows、Mac 的拦法和快照逐字不变。
- 更新页、「必须更新」提示、首页气泡、托盘、系统通知、退出确认在 Linux 上改说「安装新版本」并提前说明会弹安装窗口、
  要输开机密码。教程页文案留给 ⑩，下载页加 Linux 包留给 ⑨。
