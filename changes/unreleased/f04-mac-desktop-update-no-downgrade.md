## 用户

- Mac 上更新桌面端时，它要是自己已经升到了更新的版本，星芒不会再把它换回旧版。

## 开发

- 0.2.25 总单第 37 项（11-18 复核 F04，全面检查 D-3）：Mac 上更新 Claude Desktop、OpenCode、Codex 桌面端，要不要换只拿开始时检测读到的版本比
  （`electron/macos-desktop-app-installer.ts` 的 `installMacosDesktopApp`），换之前那一步只关进程、不再读装着的版本。下载那几分钟里它自己升到了
  比星芒下的那版还高的版本，星芒照样把它换回低版。
- 现在 `replaceBundle` 在关它之前、关完之后各现读一次装着的版本（新加的 `installedNotOlder`，用原有的 `readBundleVersion`）：已经不比下下来的那版旧，
  就什么都不动（没关的不去关，旁边那份新版删掉），返回 `unchanged` 和它现在的版本，界面照旧说「已经是最新版，不用更新」。关完再读一次是因为这几家自带的升级
  多半在退出时才换（推测）。读不出版本号就不换，报原有的「没更新成，旧版还在，照常能用。」。没加新字。
- 用例 `macos-desktop-app-installer.test.ts`：下载期间已经升过的不关它、不换；关掉以后才换成新版的也不换；读不出版本的不换。三条在旧代码上都红。
  `updateSetup` 和一条存储桶用例的假 plutil 改成读得出装着的版本（真机上本来就读得出）。
