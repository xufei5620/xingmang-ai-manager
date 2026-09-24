## 用户

- 新公告能及时看到了：软件开着的时候每隔十分钟会看一次有没有新公告，从别的窗口切回来时也会马上看一次，有新的就直接在顶部出现。软件在后台或缩到托盘时，会弹一条系统通知提醒一次（需要在「设置 → 通知」里开着桌面通知，可以单独关掉「新公告」这一项）。

## 开发

- `features/shell/Announcement.tsx`：抽出 `loadNotice`，在公告窗口关着时每 10 分钟、以及窗口 `focus` / `visibilitychange` 回到可见时静默重读（按 1 分钟限流，失败不打扰、不清空当前内容，内容没变不重渲染）。之前只在挂载、切账号、打开公告时读。
- 窗口不在前台时有没提醒过的公告，经平台通道 `notifyActivity('announcement', key)` 请求一次系统通知；文案固定在主进程（`electron/platform/notifications.ts`），渲染层只给 FNV 摘要做事件编号，本机另记已通知过的公告（`xingmang-v2-notice-notified:<scope>`），同一条只弹一次。
- `PlatformActivityKind` / 通知偏好新增 `announcement`（默认开，老设置文件缺项按默认补齐），设置页多一个「新公告」开关。
- 修 #501：`announcement-persistence.browser-check.mjs` 改为等列表稳定到预期的已读/未读状态再断言，不再在首行出现时立即读取（打开窗口和切账号都会重读，可能读到中间的加载状态）。
