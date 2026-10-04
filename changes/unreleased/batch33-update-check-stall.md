## 用户

- 检查软件更新时网络卡住、一直等不到回应，不会再一直停在「正在检查新版本…」：45 秒没动静就显示「检查更新失败」，
  点「重试」会重新去查。开机时提示过「网络有点慢…星芒会在后台接着查」的，之后的自动检查也会真的重新去查。
  「必须更新」的提示框里点「重试」后，也不会再只剩「联系客服」能点。

## 开发

- 第三十三批 B（0.2.15 发版前回归检查建议 i）：`electron/updater.ts` 的 `check()` 改等 `checkWatched()`。
  `updateCheckStallMs`（45 秒，和下载停住同一个数）里 update-request-guard 一个响应头、一个字节都没看到，就调
  `abortDownloadRequests` 掐断还开着的更新请求，以 `UPDATE_CHECK_STALLED` 加更新那张表里「超时」那句报检查失败。
  electron-updater 6.8.9 上一次检查没收场时再调，交回来的是同一个 Promise（AppUpdater.js 的 `checkForUpdatesPromise`），
  出错才清掉；以前开机检查 8 秒超时后请求一直挂着，「重试」和三小时那次都接回它，整次运行停在「正在检查」，
  最低版本那道门里只剩「联系客服」。掐断后那次检查以掐断用的错误收场，electron-updater 丢掉它，下一次检查重新发请求。
- 开机那次已经报了 `STARTUP_UPDATE_TIMEOUT`、之后没人再点检查的，掐断后保留那句话。接回同一个挂住请求的检查共用一个
  看门狗、同一个结果。掐断时之后又开始了一次检查的，只让最新那一次报（`latestCheck`），免得它还在读服务状态文件时先闪一句
  「检查更新失败」。electron-updater 为掐断的请求发的 error 事件不上屏（同下载那边的 `UpdateDownloadAborted`）。
  宿主掐不到请求时，再等 `updateDownloadCancelWaitMs` 照样报超时。main.ts 只在 `download.requests.aborted` 那条日志里
  多记一个 `reason`（`UpdateCheckAborted` / `UpdateDownloadAborted`），分得清掐的是检查还是下载。
- 沙箱用 Electron 43.6.0 加真的 NsisUpdater，对着只接连接、不回话的本地服务器演过（HTTP/1.1、HTTP/2 各一遍，计时缩短）：
  掐得断、连接关掉，下一次检查、开机超时后的「重试」、定时检查都重新发请求；只回响应头不回内容的也掐得断；每 2 秒来一个
  字节、总时长超过门槛的慢服务器不误判。改前的代码同样演法：检查一直挂着，「重试」和定时检查都不发新请求。
