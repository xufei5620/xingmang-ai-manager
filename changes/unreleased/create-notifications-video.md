## 开发

- 「创作」里生成的视频完成通知（0.2.25 复查清单第 3 条）：`useChatController.ts` 发的是 `task` 类 `video:<请求号>`，
  `electron/platform/notifications.ts` 的 `chatNoticeKind` 只认 `chat:` / `image:`，视频落回通用的「生成任务已完成」并被
  `resolveNotificationTarget` 送去「个人中心 › 异步任务」。现在 `chatMessages` 多一种 `video`，`video:` 点开回「创作」。
- 新加的视频那句跟文案正式化第 11 批（#2083）给文字、图片两句定的写法一致：「视频已生成」/「请返回星芒的「创作」页查看。」
  （yoyo 2026-11-22 回「视频通知改」；回词时 #2083 刚合，跟它撞了以后 yoyo 在决定卡上选了跟其他通知统一）。
- `notifications.test.ts` 加一条扫 `useChatController.ts` 里 `notifyActivity('task', ...)` 的前缀，每一种都必须点开回「创作」、
  用「创作」的说法；以后再加一种前缀没在主进程认，这条会红。
- 不写「## 用户」：输入框出视频是这一版才有的（第 2 步），客户没见过错的那句；改名已经写在第 1 步那条里。
