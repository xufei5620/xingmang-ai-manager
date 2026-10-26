## 用户

- 设置里的「匿名使用统计」现在会每天发一次匿名使用情况，帮我们看新版本装得顺不顺，不含账号、密钥和文件，随时能关。

## 开发

- 匿名使用统计（2026-10-26 yoyo 选的推荐档）：开着时每天最多成功发一条，内容整个写在地址里，GET 到更新目录的
  `stats/v1/…`（连不上 Cloudflare 才改发 xm-direct 同一地址），update-feed-stats 工作流按地址数，Summary 页多一节「每天打卡」。
  不带电脑编号：客户端保证一天只发成一条，所以一天一条就是一台电脑，Windows 走线路2 的也数得到。
- 一条里有：星芒版本、系统（Win10/11、macOS 大版本、Linux）、芯片、账号类型、线路、自动更新开没开、下好没装/装了没装上、
  各工具装没装和版本，以及攒下的安装失败、更新失败（按报错归成五类，原文不发）、窗口没响应、主进程卡顿、付款页慢或没打开、
  意外退出的次数。每段都从固定缩写表或版本号样式来，认不出的写 x（`electron/usage-stats.ts`，纯函数全测）。
- 发送和本机计数在 `electron/usage-stats-reporter.ts`：开机 3 分钟后发、之后每 6 小时看一次换没换天，一天最多试 3 次；
  不带 cookie、拒绝重定向、10 秒超时、读回包限 16 KB（I10）；计数文件 `usage-stats.json` 走 safe-local-data 原子写，
  每种最多 99、最多留 7 天，关掉开关当场删掉（设置页存好开关后经 `platform/privacy-change-bridge.ts` 告诉主进程，
  不等下一次定时检查）。开发版、本机自编版、CI 和 `XINGMANG_DISABLE_USAGE_STATS=1` 不发。
- 开关是系统界面设置里原有的 `privacy.anonymousUsage`：没碰过 = 开，文件里存着 false 的照旧关。登录后一次性卡片
  （`AppSettings.usageStatsNoticeShown`），错误报告那张这次出过就等下次打开。不新增 IPC 通道：`registerIpcHandlers`
  多一个可选的 `observeOperation`，参数只给 `cli:install` / `external-clients:install` 的第一个（装哪个工具）。
