## 开发

- 一键安装 Codex 桌面端、Claude Desktop 时先从星芒自己的腾讯云存储桶下同一个官方包，
  没走通才照旧走原来的路（yoyo 2026-10-10「需要从存储桶下载，因为后期我打算去掉游戏加速这个功能」）。
  新模块 `electron/desktop-package-bucket.ts`：桶地址写死；清单里的对象路径、地址、大小、
  SHA-256、类型、校验标签一处对不上就不用；不跟跳转；照当时速度还要 10 分钟以上就放弃。
  原因只进运行日志（`desktop-bucket.fallback`），界面文字沿用原来那几句，没有新增。
- Windows：Codex（`downloadCodexDesktopBucketPackage`，排在微软商店前面；桶里那一版不比本机新就跳过）、
  Claude（`installClaudeDesktopFromBucket`，排在 winget 前面）下完照旧核包身份、发布者、签名，
  且包版本必须和清单一致，装法与官网那一路共用。下好、核过却装不上时照官网那一路报错，不再换路重下。
- Mac：Codex 用桶里按芯片的 zip，Claude 用通用 PKG（`pkgutil --expand-full` 只展开、不安装，
  找出唯一的 Claude.app），解开后照旧核 bundle id、最低系统、Team ID 签名和 Gatekeeper。
  `installMacosDesktopApp` 新增 `bucket` 与 `withVendorDownloadRoute`：调用方不再把整个安装包进
  加速线路，只有问官方那一路接线路，桶那一路国内直连。
- `docs/COS-SYNC.md` 写清客户端认清单里的哪些字段；同步脚本改这些字段会让客户端全部退回原来的路。
