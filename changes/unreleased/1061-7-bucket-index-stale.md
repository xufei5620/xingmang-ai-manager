## 用户

- 星芒的下载源一时没跟上官方新版时，装或更新 Codex 桌面端、装最新版 Grok 会直接从官方下载，不再装上旧版、装完还提示有更新。

## 开发

- #1061 第 7 条（桶清单过期不再装到旧版）：两份同步索引多一个 `checkedAt`，是这次同步问过官方、核对过的时间。`sync-chatgpt-official-cos` 一个作业只核自己那个平台，写在 `platforms` 下各条上，其它平台留着它们上次的时间；`sync-grok-cos` 一次核完两个芯片，写在顶层。包一个都没变也照样重写一次索引、只刷新这个时间（不下大文件，Codex 那边也不建临时目录），结果里的 `changed` 仍按包变没变算。以前包没变就不写，`generatedAt` 是「内容最后一次变」的时间，拿它判过期会把一切正常、只是官方几天没出新版的桶也当成过期。
- 客户端：`readDesktopBucketPackage` 读 Codex 那份清单（Windows、Mac 都是）时，那一条的 `checkedAt` 没写、格式不对，或离桶回应的 `Date` 超过 24 小时（`desktopBucketIndexMaximumAgeMs`，读不出 `Date` 才用本机时间，客户电脑时钟可能差好几天），就抛 `DesktopBucketUnavailableError`，照旧换商店、官网、国内镜像（Mac 是官方更新信息）。`readGrokBucketRelease` 只在装最新的（没点名或 `latest`）时看顶层的 `checkedAt`，点了名的版本（推荐版本、退回）照旧从桶里装，桶里那份和 xAI 的是同一个文件。Claude 桌面端、OpenCode 的同步还不写这个时间，它们的清单照旧不看。原因只进运行日志（`desktop-bucket.fallback` / `grok-bucket.fallback`）：「存储桶清单超过 24 小时没和官方核对过（上次是 …），桶里的可能不是最新版」，不上屏。
- `grok-installer.ts`、`codex-desktop-service.ts` 不用改：两边本来就把清单读不出当成换路。这个 PR 合进去以后，下一次定时同步（6 小时内）就会写上 `checkedAt`；在那之前打出来的测试包读到的清单没有它，装最新版会走官方那几路。
