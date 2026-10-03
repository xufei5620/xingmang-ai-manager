## 用户

- Mac 上新版本下载好了、系统却校验没通过装不上时，更新页和首页右上角的提示不再显示半句英文，
  改说清楚「再点也一样」，按钮从「重新安装」换成「打开下载页」，下载新版本的安装包手动装一次就好。

## 开发

- `electron/updater.ts` 的 `safeError`：darwin 上认出 Squirrel.Mac 的「Code signature … did not pass validation」
  （含系统中英文原因），给单独的错误代码 `UPDATE_SIGNATURE_REJECTED` 和中文正文，原话只进 `detail`。以前这句夹着
  macOS 的中文原因，`describeUnrecognizedUpdateFailure` 把它当成本来就是中文整句上屏，路径还被打码成「本地配置文件」。
- 渲染层 `features/app/update-retry.ts` 的 `updateNeedsManualReinstall` 按这个代码把更新页失败卡与首页气泡的主按钮
  换成「打开下载页」（`appReleaseDownloadUrl`）。验签失败对这次安装是终局：同一个包每次重试结果一样。
  更新页卡片头的「重启安装」与「必须更新」那道门的「重新安装」这次不动，另等确认。
- 已知没覆盖：「自动更新」开着时，退出时自动装被拒，下次打开仍先显示「上次没装上…点「重新安装」」，点一次后才换成这句；
  要在 pending-update 记录里带上失败原因，留作后续。
- `electron/ipc.ts`：`update:install` 成功日志改为「已把新版本交给安装程序，装没装上看下一条更新状态」，
  不再写「主程序更新安装完成」，免得反馈报告里先「完成」后失败。
