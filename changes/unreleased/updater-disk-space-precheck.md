## 用户

- 电脑磁盘快满时，自动更新不再每隔几小时下一次注定失败的安装包：会先说清磁盘还剩多少、装更新大约要多少、还要再清出多少，清出空间后自动接着下载，不用你再点。更新页多了「怎么清理」（照着清的步骤）和「仍要下载」。

## 开发

- `updater.ts` 的 `download()` 下载前经 `readFreeDiskBytes` 量盘（`main.ts` 量 electron-updater 缓存目录与临时目录里最紧的那块，读不到放行）；需要空间按 latest.yml 的 `files[].size × 3`，至少 300 MB，没有 size 按 600 MB。不够时 phase 仍是 `available`，快照带 `diskShortfall`，不进 `error`；运行日志记 `update.download.skipped.disk`。`update:download` 可带 `{ ignoreDiskSpace: true }` 跳过这一次预检（`parseUpdateDownloadOptions` 字段白名单）。
- 说法只在 `electron/disk-space-copy.ts` 一处，系统通知与 renderer-v2（首页气泡、更新页）共用；`formatFreeSpace` 挪进这个无 Node 依赖的模块，`disk-space.ts` 原样再导出。第二十二批 2。
