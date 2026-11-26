## 用户

- 修复了部分 Windows 家庭版电脑上 Codex 桌面端无法打开且未说明原因的问题，现将说明原因并给出处理办法。

## 开发

- 补 #2139（打开前联网验证超时，`codexDesktopActivationOffline`）和 #2150（Windows 更新被关挡住首次启动，
  `codexDesktopWindowsUpdateBlocked`）给客户看的那一句，两个 PR 的分片当时只写了「## 开发」。
  文件名用 `002-` 开头：这是客户报过的问题，排在更新页前面。（yoyo「家庭版说明加」）
