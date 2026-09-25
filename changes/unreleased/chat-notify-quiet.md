## 用户

- 正在看聊天窗口时，AI 回完一句或图片生成好，不再弹系统通知；窗口在后台时改说「AI 回复好了」「图片生成好了」，不再借用「异步任务已完成」那句。
- 点系统通知会停在对应的页面：余额提醒到「充值与订阅」，聊天和图片到「聊天」，异步任务到个人中心的「异步任务」，装工具和工具有新版本到首页，新公告直接打开公告。
- 设置 → 通知里「异步任务完成」的说明改成连聊天、图片一起说清。

## 开发

- `electron/platform/notifications.ts`：新增 `resolveNotificationTarget`（点击去处由主进程按种类与编号前缀定死，渲染层无法指定页面）与 `buildActivityNotificationMessage`（task 类 `chat:` / `image:` 前缀换聊天说法）；`createPlatformNotifications` 多一个可选 `openPage`，缺省＝旧行为只叫出窗口。`install-system-api.ts` 经已有的 `navigation:open-page` 事件发给主窗口（同状态推送的 sender URL 校验），没有新增请求通道。
- `RendererNavigationTarget` 加 `home` / `chat` / `tasks` / `announcement`；legacy `src/App.tsx` 只跟着类型忽略这几个值（这条事件只在 v2 下出现）。
- `useChatController.ts` 两处通知复用 #576 的 `isWindowInFront`。
