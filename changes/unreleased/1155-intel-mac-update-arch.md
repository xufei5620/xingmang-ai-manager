## 开发

- Intel Mac 自动更新不再可能被换成 arm64 包（#1155 第 3 条）。electron-updater 6.8.9 的 `MacUpdater` 拿 `uname -a`
  里有没有「ARM」判断 Apple 芯片，`uname -a` 带着电脑名，Intel Mac 叫「ARM-…」「CHARM…」时它会挑 arm64 包，
  装上打不开。现在主进程把「这台 Mac 能不能跑 arm64」（`process.arch === 'arm64' || app.runningUnderARM64Translation`）
  交给 `createUpdaterService` 的 `macRunsArm64`；跑不了时，`update-available` 那一刻就地拿掉清单里的 arm64 包，
  连同指着 arm64 包的老字段 `path` / `sha512`（`buildIntelMacUpdateInfo`），electron-updater 下载时只剩 Intel 版可挑。
  下载完核对 SHA-512 时按同一条规则再收窄一次，哪天 electron-updater 不再从那份清单下载，arm64 包也对不上核对值、照样拒装。
  Apple 芯片上经 Rosetta 跑 Intel 版的照旧由 electron-updater 换回 M 系列芯片版。没有新增界面文字。
- 反馈报告「运行环境」段在 Mac 上开头多两行（#1155 第 4 条）：`macOS 版本`（`process.getSystemVersion()`）和
  `Mac 芯片`（Intel 处理器 / Apple 芯片，装的是哪一版，经没经 Rosetta），客服能分清是不是装错了包
  （`electron/feedback-environment.ts`）。检查页「操作系统」一项在 Apple 芯片上跑 Intel 版时不再说成「Intel 芯片」，
  改按真实芯片说「Apple 芯片」，`details` 多记 `appArch`、`rosetta`（`electron/diagnostics.ts`，用的是原有字样）。
