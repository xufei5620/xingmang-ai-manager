## 用户

- 下载新版本时，更新页和「需要更新后才能继续用」那一页的进度条下面多了一行：已下载多少、一共多少、每秒多快、大约还要多久。刚开始下载、速度还算不出来时只显示下了多少。

## 开发

- `electron/updater.ts`：`download-progress` 时记最近 10 秒的进度样本（`recordDownloadProgressSample`，已下载量变少即视为重新开始、清空样本），样本跨度满 3 秒才给 `progress.averageBytesPerSecond` 与 `progress.secondsRemaining`；两个字段可选，缺省＝只显示已下载/共多少。原样转发的 `bytesPerSecond` 不变（legacy 仍读它）。
- `src/renderer-v2/registry/business.ts` 新增 `updateDownloadDetail` / `formatDownloadBytes` / `formatDownloadRemaining`，剩余时间按 10 秒、分钟粗取整，免得每秒跳数字；更新页（`pages-maintenance.tsx`）与强制更新门（`required-update.ts` 的 `progressDetail`、`RequiredUpdateGate.tsx`）读同一份。
