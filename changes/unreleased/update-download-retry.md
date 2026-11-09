## 用户

- 后台下载新版本时网络断了一下，星芒会过几分钟自己再下，不用再等几个小时。

## 开发

- 自动更新后台下载没下成时补试（深查 Z-3）：以前只有停住、代理连不上当场重下一次，连接被重置、更新服务器回 5xx、
  换了网络这些都要等 3 小时那次定时检查从头再下。现在「自动更新」开着、失败又是过一会儿就可能好的那种
  （`isTransientDownloadFailure`：`network-failure.ts` 归得出原因的网络失败，证书被换和本机时间不准除外；看门狗停住；
  `isServiceUnavailableResponse` 认的 5xx），就隔 5、15、45 分钟（`updateDownloadRetryDelaysMs`）各跑一次
  `scheduledCheck`，补试里检查没查成也接着排，同一个版本三次用完回到 3 小时那一轮。已经排着一次时不另排（客户自己点
  重新下载、3 小时那次在中间失败都不多用掉一次）；下好、核对不过（`rejectDownloadedUpdate`）、`dispose` 都清掉；到点时
  阶段已经不是 error、版本换了、开关关了就不动。日志 `download.retry.scheduled`。顶掉手里下好的版本以后新版本没下成
  （Z-1 第 2 条）也走这条。
