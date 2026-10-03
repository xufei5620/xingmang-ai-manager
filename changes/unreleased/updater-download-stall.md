## 用户

- 下载软件更新时网络断了、或者代理软件不再转发，不会再一直停在「正在下载」：45 秒收不到新数据就自动换条路
  重下一次，还是不行就显示「下载更新失败」，点「重新下载」再试。必须更新的提示框也不会再只剩「联系客服」能点。
  停住的那会儿，也不再一直显示停住前的速度和剩余时间。下载更新到一半网络断开，软件也不会再因此自己关掉又重新打开。

## 开发

- 第二十七批 A：electron-updater 6.8.9 自带的 60 秒超时在 Electron 里从来不生效（builder-util-runtime 把它挂在
  请求的 `socket` 事件上，Electron 的 net 请求不发这个事件），下载中途断网、代理不转发时就一直挂着，不报错也不重试。
- 新模块 `electron/update-request-guard.ts`，`main.ts` 用它包住 electron-updater 的 `httpExecutor.createRequest`：
  记下更新请求最近一次收到响应头或数据的时间；停住时让还开着的请求像断网一样以错误收场，再 `abort()` 放掉连接。
  增量下载（只下改了的那几段）不认取消令牌，靠它才停得下来。它还给每个响应挂一个空的 `error` 监听：electron-updater
  多段增量下载的那个响应没挂，连接中途断开就成了没人接的异常，`main.ts` 当主进程意外出错退出再重开（沙箱 Electron
  43.6.0 实测，HTTP/1.1、HTTP/2 都会）。electron-updater 没读就拒掉的响应（几段一起要却回了 200 整个文件、
  Content-Type 不对、HTTP 出错）不去读它：Electron 只在有人读时才往下收，读了就会在它改下整包的同时把被拒的
  那份整个安装包也下完。
- `electron/updater.ts` 的 `downloadWatched`：electron-updater 的进度和宿主看到的字节（`downloadReceivedAt`）都算动静。
  还在传时 `updateDownloadStallMs`（45 秒，与 `download-retry.ts` 同一个数）、进度到过 100% 以后
  `updateDownloadSettleMs`（180 秒：签名核对、改名重试都不报进度）没动静就算停住：取消令牌，经
  `abortDownloadRequests` 掐断请求，照代理连不上那条路换直连重下一次整个安装包（`disableDifferentialDownload`）；
  再停住就报 `UPDATE_DOWNLOAD_STALLED`，正文沿用更新那张表里「超时」那句，`failedStep` 为 `download`。
- 掐断以后 10 秒没收尾、期间也没再来数据才不再等它（`unsettled: true`，不自动重下，再下 electron-updater 只会交回
  同一次）；机器睡醒、时钟往前或往回跳都从那一刻重新计时。被放弃的那次之后发来的 `update-cancelled` 和进度不落进
  快照，晚到的出错记在下载那一步（正在检查时来的出错仍算检查的），真下完了照常落到「已下载」。停住时每 5 秒按
  「这段时间没进账」重算平均速度。
- 不用 `session.closeAllConnections()`：沙箱实测它关不掉正在用的 HTTP/1.1 连接，HTTP/2 下又会触发上面那个没人接的异常。
- 日志：`updater/download.stalled`（warn，带 `retrying`、`unsettled`、`fullPackage`、`transferEnded`、`transferred`、
  `total`），`updater/download.requests.aborted`（info，掐断了几个请求），`updater/runtime.selected` 多了 `requestGuard`。
- 验证：单测（假计时器）；沙箱 Electron 43.6.0 + 真的 electron-updater（Windows 的 `NsisUpdater`），计时缩短，对着
  本地更新源（HTTP/1.1、HTTP/2）演过：多段增量下载停住一次换整包重下成功、停两次报下载失败，单段增量下载停住，
  连接中途断开（不再有没人接的异常），单段增量下载慢但一直有数据（不误判），下完以后核对签名慢（不误判），
  几段一起要却回了 200 整个文件（被拒的那份不再整个下完）。Windows / Mac 真机、线上更新源都没演过。
