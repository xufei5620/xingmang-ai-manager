## 用户

- 工具出新版本时的系统通知，标题从「命令行工具有新版本」改成「工具有新版本」；设置 → 通知里这一项的说明也改成「你装的工具出新版本时提醒一次」。
  只装了 Codex 桌面端的客户，桌面端出新版时不会再收到说「命令行工具」的通知。

## 开发

- 第三十二批 B：`electron/platform/notifications.ts` 里 `cliUpdate` 的通知标题、`src/renderer-v2/registry/business.ts` 里设置项的说明去掉「命令行」。
  这条通知按 `pendingToolUpdates` 算，Codex 桌面端镜像有新包时也算在里面；Windows 客户反馈报告里真发过一条
  `cli-update:codexDesktop.26.928.3736.0`，当时四家 CLI 一个没装。正文、哪些工具算进这条通知、点通知去哪一页都不变。
