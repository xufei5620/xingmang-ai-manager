## 用户

- 网慢时装命令行工具不再白等、不再从头下：安装或更新命令行工具时，开头连 npm 官方源核对安装清单那一步要是 3 分钟一点数据都没收到，就直接停下告诉你没连上，不用再干等满 10 分钟，网慢但一直在收的照旧等它收完；在 Windows 上装或更新 Grok CLI、要从 xAI 官方下载时，网络断一下或卡住不动，会从断开的地方接着下，不再换个地址从头下这 170 MB。

## 开发

- #1057 第 5b 条前半：`system-service.ts` 的 `resolveDependencyGraph`（`npm install --package-lock-only`，装之前到官方源核对一次、每个源各自再解析一次）接上 `npm ci` 已有的 `createNpmDownloadStallWatch`，量这一次的 resolution 目录加缓存目录，3 分钟（`npmDownloadStallTimeoutMs`）一点没变就中止；`npmResolutionTimeoutMs` 10 分钟留作兜底。容器里实测 npm 10.9：解析时拉的包信息照样边收边写进 `_cacache/tmp`，慢慢收时文件一直在长，连上不回数据时目录一个字节都不变。
- 卡住被停和满 10 分钟超时报同一句（都是 `npmDownloadTimedOutReason`）：官方源那一步照旧出 #1188 的「装之前要先到 npm 官方源核对安装清单，这一步没连上……」，某个源自己那一步照旧记成这个源超时、换下一个源。运行日志多一条 `cli.install.resolution-stalled`。客户点取消照旧是取消。
