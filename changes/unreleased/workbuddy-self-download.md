## 用户

- Windows 上 WorkBuddy 改成到腾讯官网自己下载安装：首页那一行的按钮换成「去官网下载」，
  装好后回星芒点「重新检测」，认出来以后照旧一键配置、打开。

## 开发

- Windows 上 WorkBuddy 不再一键安装（yoyo 2026-10-13「WorkBuddy 改成客户自己下载」），星芒只管认出来和写配置。
  `external-client-runtime.ts` 的 `windowsWithoutWinget` 换成 `windowsInstallRoute`：WorkBuddy 不论有没有
  winget 都给 `installSupported: false`、说明「到腾讯官网下载安装，装好后回来重新检测」和下载页
  `https://www.workbuddy.ai/`（加进 `externalClientOfficialDownloadUrls`，`main.ts` 外链白名单随之全等收录）。
  Windows arm64 照旧「暂不支持」，Mac 照旧「安装指南」。
- 去掉 WorkBuddy 的 winget 安装和星芒自己下腾讯安装包两条路：删除 `electron/workbuddy-installer.ts`
  （固定 5.5.6 与两枚 SHA-256 一起去掉）及其测试、Windows CI 冒烟里那条签名脚本，`install()` 里只剩
  Claude Desktop 有官方包兜底，`wingetSourceUnavailable` / `installerStarted` 随之删除。
- 认没认出来不变：仍看卸载记录登记的位置、`WorkBuddy.exe` 和腾讯签名，跟谁装的、装在哪个盘无关。
  `install-leftovers.ts` 保留 `workbuddy-` 两个前缀，清掉老版本下包落下的临时目录。
