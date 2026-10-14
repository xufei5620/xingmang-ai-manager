## 开发

- Windows 装 Grok 先从星芒的腾讯云存储桶下同一个 xAI 签名的 `grok.exe`（yoyo 2026-10-14「放桶」，为的是去掉游戏加速）。
  新工作流 `sync-grok-cos`（`scripts/sync-grok-cos.cjs`，Windows 机器，每 6 小时）问 xAI 现在的 stable，
  再读 `cli-verified-versions.ts` 里 Grok 的推荐版本，两版的 x64、ARM64 缺哪个下哪个；核 PE 头芯片和
  `Get-AuthenticodeSignature`（有效、X.AI LLC）后传到 `xingmang/offline/grok/<平台>/sha256-<摘要>/`，最后改 `latest.json`，清单留最近 12 版。
- 客户端新模块 `electron/grok-bucket.ts`：桶地址与清单路径写死；点名的版本比桶里的 stable 新、或桶里没有，就交给 xAI 那一路
  按真正的 stable 定（桶会晚一个同步间隔）；装最新版时桶里那一版不比本机新也去 xAI。清单里的路径、地址、大小、SHA-256、
  类型、校验标签一处对不上就不用。`grok-installer.ts` 下完照旧跑 X.AI LLC 的签名核对，一行没放宽；没走通悄悄改去
  xAI（运行日志 `grok-bucket.fallback`），下载加速线路改成只在去 xAI 时才借。
- Mac 一键装 OpenCode 和 Codex、Claude 桌面端一样先从桶里下（yoyo 2026-10-14「做」）。新工作流 `sync-opencode-cos`
  （`scripts/sync-opencode-cos.cjs`，Mac 机器，每 6 小时）问 GitHub 上 OpenCode 的 `latest.json`，版本变了才下两种芯片的
  `.app.tar.gz`，解开核 bundle id、版本、芯片、Team `5NZ4Q7NXJ4` 的 Developer ID 签名和 Gatekeeper 后传到
  `xingmang/offline/opencode/`。客户端 `desktop-package-bucket.ts` 认这份 `files` 清单，`macos-desktop-app-installer.ts`
  用 `tar -xzf` 解开后照 GitHub 那一路核；没走通改去 GitHub。
- Mac 装 Grok 不再先问 x.ai 的 stable，只问 npm（同 Linux）：`resolveCliInstallRelease` 去掉 Grok 的 stable 上限分支，
  Mac 的「最新版本」也改读 npm。npm `latest` 就是 xAI stable，二进制签名照旧核。
- 两条新工作流沿用 `xingmang/*` 的权限和 `cos-sync` 环境，不用新密钥；连续失败两次照样开 issue 报警
  （`cos-sync-alert.cjs` 加了这两条和它们的「影响」说法），`cos-sync-utils.cjs` 的可覆盖名单加了两份 `latest.json`。
  界面文字没有改。
