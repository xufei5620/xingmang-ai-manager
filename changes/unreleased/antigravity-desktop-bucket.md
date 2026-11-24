## 开发

- 0.2.25 复查 A 第 1 轮第 2 条：Antigravity 桌面端以前只从谷歌下，国内多半装不上。照 agy 那一路加存储桶：新同步作业
  `sync-antigravity-desktop-cos`（每 6 小时，也可手动跑）在 Windows、Mac 机器上各跑一次，读谷歌给桌面端自己更新用的
  `latest-<x64|arm64>-<win|mac>.yml`，按其中的大小和 SHA-512 下原件，核过签名后放进 `xingmang/offline/antigravity-desktop/`，
  各写一份清单（`windows.json`、`macos.json`）：Windows 安装包核 Google LLC 的 Authenticode 签名（签发机构同 agy 钉住），
  Mac zip 解开核只有一个 `Antigravity.app`、bundle `com.google.antigravity`、版本号同清单、谷歌团队 EQHXZ8M8AV 的
  Developer ID、Gatekeeper 和芯片。两种芯片版本对不上、比桶里旧时这一轮不发；对象不可覆盖、完整回读；连续两次定时失败开 issue。
- 客户端两边都改成先从桶里下：Windows（`antigravity-desktop-windows.ts`）照旧核谷歌签名再运行，Mac 走
  `macos-desktop-app-installer.ts` 已有的桶那一路，按这台 Mac 的芯片挑包（Rosetta 下也拿 Apple 芯片那份）。清单超过 24 小时
  没和谷歌核对过时先问谷歌，谷歌不通再用桶里那份；桶不通、字节对不上、签名不对都改去谷歌，原因只进运行日志
  （`antigravity.desktop.bucket-fallback`）。`desktop-package-bucket.ts` 的地址白名单加了 `antigravity-desktop` 目录。
  Mac 上桶的包号原来按星芒自己的芯片挑，改成按 `context.architecture`，Codex、Claude、OpenCode 没开 `packageForHardware`，两者相同。
