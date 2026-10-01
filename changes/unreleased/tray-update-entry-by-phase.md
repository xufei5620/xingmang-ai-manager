## 用户

- 托盘菜单里的「软件更新」不再一闪而过：只要发现了新版本，正在下载、已经下好都一直看得见；下好后直接显示「重启并安装新版本 x.y.z」，点一下就装，不用先把窗口叫出来。电脑空间不够、下载或安装没成功时，这一项也会说清楚，点开就是更新页。

## 开发

- `electron/application-tray.ts`：托盘快照的 `updateAvailable` / `updateVersion` 换成 `update: TrayUpdateEntry`，由新纯函数
  `resolveTrayUpdateEntry(UpdateSnapshot)` 按阶段给出 available（含 `diskShortfall` 时「等电脑腾出空间」）/ downloading /
  downloaded / failed。原来只认 `phase === 'available'`，自动下载开着时这个阶段只停几秒，常驻托盘的人几乎看不到。
- downloaded 那一项点击走新增的可选 `onInstallUpdate`，`main.ts` 接到 `updaterService.install()`——和更新页「确认重启安装」、
  IPC `update:install` 是同一条路，退出交接、安装闸、强制更新与 Windows 提权逻辑都不变，也不改自动安装默认值。
  带错误的 downloaded（安装器起过又失败，安装闸已关）与下载失败归为 failed，只打开更新页；检查失败不显示版本。
- 第二十四批候选 ⑩。
