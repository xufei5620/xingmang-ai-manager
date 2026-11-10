## 开发

- 0.2.24 深查改字批次 Z09（W34 W35 D19，yoyo 11-10「按照你的推荐做」）：`Announcement.tsx` 新增 `formatAnnouncementLoadError`，
  读公告失败统一上屏「公告暂时没读到，过一会儿点铃铛再看。」，服务端原话和状态码只留在主进程 IPC 失败那一行日志里
  （`ipc.ts` 的 `recordFailure`，`account:get-notice` 本来就记 error，`new-api-client.ts` 不用动）；公告太大（W34）和合集读不出来
  （W35，`newapi-announcements.ts` 四处报错合成一句，改抛 `AnnouncementCollectionError`）照各自那句，因为它们另有去官网的路。
  首页提示区那行报错去掉，只在铃铛小框和公告大框里显示。已读没记上统一显示「没记上已读，下次打开可能还会提醒。」，
  不再接原话。打开链接失败、旧式公告「标为已读」失败仍走 `formatAnnouncementError`，不在这批里。
