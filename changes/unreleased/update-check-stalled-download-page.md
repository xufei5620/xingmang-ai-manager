## 用户

- 检查更新一直没动静、最后报超时以后，更新页在「重试」旁边多给一个「打开下载页」，网络总是连不上更新服务器时可以直接去下载页装新版本。

## 开发

- `src/renderer-v2/features/app/update-retry.ts` 的 `updateOffersDownloadPage` 把 `UPDATE_CHECK_STALLED`（`updater.ts` 的 `reportCheckFailure`，看门狗掐断挂住的检查）也算进去，更新页和首页气泡同读这一份；用的是现成的「打开下载页」按钮，没新写字。普通的检查失败（断网、解析失败等）照旧只给「重试」。
- 已知问题清单 2026-10-06 已知 14。
