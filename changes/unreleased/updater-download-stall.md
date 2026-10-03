## 用户

- 下载软件更新时网络断了、或者代理软件不再转发，不会再一直停在「正在下载」：45 秒收不到新数据就自动换条路
  重下一次，还是不行就显示「下载更新失败」，点「重新下载」再试。必须更新的提示框也不会再只剩「联系客服」能点。
  停住的那会儿，也不再一直显示停住前的速度和剩余时间。

## 开发

- 第二十七批 A：electron-updater 自带的 60 秒超时在 Electron 里从来不生效（builder-util-runtime 把它挂在请求的
  `socket` 事件上，Electron 的 net 请求不发这个事件），下载中途断网、代理不转发时就一直挂着，不报错也不重试。
- `electron/updater.ts` 的 `downloadWatched`：每次下载配一个取消令牌（`main.ts` 用 electron-updater 导出的
  `CancellationToken`），`updateDownloadStallMs`（45 秒，与 `download-retry.ts` 同一个数）没有新进度就取消，
  照代理连不上那条路换直连重下一次，并且这次关掉增量下载（`disableDifferentialDownload`）；再停住就报
  `UPDATE_DOWNLOAD_STALLED`，正文沿用更新那张表里的「超时」那句，`failedStep` 为 `download`。到 100% 后不再计时
  （签名核对、改名、SHA-512 都不报进度）；停住时每 5 秒按「这段时间没进账」重算平均速度，10 秒左右就不再显示速度。
- 增量下载不认取消令牌：取消后等 10 秒还没收尾就不再等它，也不自动重下（再下 electron-updater 只会交回同一次），
  日志里 `unsettled: true`。被放弃的那次之后发来的 `update-cancelled` 和进度一律不落进快照，真下完了照常落到「已下载」。
- 不用 `session.closeAllConnections()` 去掐：沙箱里用 Electron 43.6.0 对着中途停发的本地服务器实测过，它关不掉
  正在用的 HTTP/1.1 连接；HTTP/2 下会让 electron-updater 多段下载那个没挂 `error` 监听的响应抛未捕获异常，
  客户看到的是 Electron 的英文报错框。
- 新日志 `updater/download.stalled`（warn），带 `retrying`、`unsettled`、`transferred`、`total`。
- 验证：单测（假计时器）；沙箱 Electron 43.6.0 + 真的 electron-updater（Linux 的 DebUpdater，整包下载那条路）对着
  中途停发的本地更新源各演一遍（计时缩短）：停一次换直连重下成功，停两次报下载失败。Windows / Mac 真机、
  线上更新源、增量下载整条路都没演过。
