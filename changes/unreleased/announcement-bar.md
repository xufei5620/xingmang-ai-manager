## 用户

- 公告提示不再一直占着一整行：横条右边多了关闭按钮，关掉或打开看过公告后，横条和铃铛上的红点都会收起，有新公告时才再提醒。公告列表里每条的「已读 / 未读」照旧。

## 开发

- `features/shell/Announcement.tsx`：横条与铃铛红点改看「还没看过的公告」（本机 `xingmang-v2-notice-seen:<scope>`，最多记 200 条），打开公告中心或点横条的关闭按钮即记为看过；逐条已读状态与服务端/本机已读写入不变。去掉横条上旧的单条公告「标为已读」小勾，统一换成关闭按钮。
- `newapi-announcements.ts` 新增 `announcementAttentionKeys` / `readSeenAnnouncementKeys` / `rememberSeenAnnouncementKeys` 及单测；`app-check.mjs` 相应调整红点断言并新增关闭、刷新后保持、新公告重新提醒的浏览器回归。
