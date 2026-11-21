## 开发

- 「创作」里生成的视频完成通知（0.2.25 复查清单第 3 条）：`useChatController.ts` 发的是 `task` 类 `video:<请求号>`，
  `electron/platform/notifications.ts` 的 `chatNoticeKind` 只认 `chat:` / `image:`，视频落回通用的「生成任务已完成」并被
  `resolveNotificationTarget` 送去「个人中心 › 异步任务」。现在 `chatMessages` 多一种 `video`，`video:` 点开回「创作」。
- 三句通知按 2026-11-21 定的正式口吻重写，「聊天」跟着第 1 步的改名换成「创作」：「AI 已回复」「图片已生成」「视频已生成」，
  正文都是「请回到星芒的「创作」查看。」（yoyo 回确认词后才改）。其他种类的通知没动，留给文案正式化的主进程那一批。
- `notifications.test.ts` 加一条扫 `useChatController.ts` 里 `notifyActivity('task', ...)` 的前缀，每一种都必须点开回「创作」、
  用「创作」的说法；以后再加一种前缀没在主进程认，这条会红。
- 不写「## 用户」：输入框出视频是这一版才有的（第 2 步），客户没见过错的那句；改名已经写在第 1 步那条里。
