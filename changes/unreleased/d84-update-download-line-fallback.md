## 开发

- 安装包在线路2 下不动时换回线路1 再下（决定单 D84，深查 Z-2）：以前只有检查更新会在直连那份更新地址（xm-direct）没走通时
  换回包里那份，下载失败只在停住、代理连不上时换直连重下一次，Windows 星芒账号选「自动」、走线路2 的客户碰上洛杉矶那台
  能回清单、大文件下不动或半路断，只报「下载更新失败」。现在 `UpdateFeedRouting` 多一个可选的 `fallBackDownload`：
  原有的那次自动重下之后还没下成，宿主（`bootstrap/updates.ts`）在「自动」且当前用的是直连那份时按
  `classifyDirectFeedDownloadFailure`（`update-feed-route.ts`）判断，换回包里那份，`updater.ts` 在那份上重查一次再下一次
  （electron-updater 下载用的是检查时那份地址，光 `setFeedURL` 不重查还是去直连）。手动固定线路2 的不换；盘满、文件被占、
  核对不过、electron-updater 那次一直没收尾的不换。停住、下到一半断了（`ERR_CONTENT_LENGTH_MISMATCH`、
  `ERR_INCOMPLETE_CHUNKED_ENCODING`）只换这一次、不报给线路那边；连不上一类和 502/503/504 跟检查一样报。重查那一下阶段留在
  「正在下载」（不闪回「有新版本」，免得强制更新门和自动更新再起一次下载），已经在下的那一版不受分批放量收回；代理已经确定
  连不上的，这一次照样绕开代理。没加界面文字。日志 `feed.download-fallback`，`download.stalled` 多一个 `switchingFeed`。
