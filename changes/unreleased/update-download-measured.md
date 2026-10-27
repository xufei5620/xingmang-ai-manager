## 开发

- 更新下好时多记一条日志 `updater/download.measured`：这一次实际从网上下了多少字节（`receivedBytes`，
  增量下载的块表、改了的那几段、增量没成时改下的整包、停住或代理连不上后的重下都算在内），跟清单里
  下好的那个安装包有多大（`packageBytes`）、占几成（`percent`，整包时会略过 100）、重下过没有、用了多久
  放在一起，好看增量下载到底省了多少（在线热更新方案 B1）。字节由 `update-request-guard.ts` 在
  electron-updater 读的响应上数（新增 `receivedBytes()`），`updater.ts` 新增 `downloadReceivedBytes` /
  `downloadMeasured` 两个可选钩子，日志字句在 `update-state-log.ts` 的 `buildUpdateDownloadMeasureLog`。
  界面不变，下载失败的那次不记。
