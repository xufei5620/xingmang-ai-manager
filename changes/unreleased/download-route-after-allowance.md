## 用户

- 免费加速时长用完的账号，装或更新命令行工具、装 Node.js、Git、Python、下载 Codex 插件目录时，也照样自动走下载加速。这条线路只给下载用，不改电脑网络设置，不扣也不补免费时长。

## 开发

- `acceleration-development-backend.ts` 的 `startDownloadRoute` 去掉「免费时长用完就返回 unavailable」的门槛（yoyo 2026-10-01 回「放开」）；仍不写免费时长账本，加速页照旧显示用完。测试改钉「用完后照样起、账本不变」。
