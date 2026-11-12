## 开发

- Mac「卸载星芒」勾了「连同星芒替你装的命令行工具一起删」时，`removeMacManagedTools`（`electron/macos-uninstall.ts`）改用 `removeTree` 删
  `~/Library/Application Support/XingMangAI`（0.2.24 深查·装工具和更新 S-2）。装桌面端被关机、强退打断时 `DesktopApps/staging-*`
  里会留下解开的 `.app`，主进程的 fs 把里面的 `app.asar` 当成文件夹（#1573 同一个根因），整棵删除报 ENOTEMPTY，客户的 CLI 和 Node
  留在电脑上。新用例在真 Electron 里跑这个函数，旧代码上报的正是 ENOTEMPTY。界面字不变。
