## 用户

- 在「插件」里给 Codex 下载插件目录时，先从星芒自己的下载服务器下，国内更快更稳；那边下不了会自动换回原来的下载办法，不用你多点。

## 开发

- Codex 官方插件目录放进星芒的腾讯云存储桶（yoyo 2026-10-13「插件目录放存储桶」，为的是以后去掉游戏加速）。
  新工作流 `sync-codex-plugins-cos`（`scripts/sync-codex-plugins-cos.cjs`，每 6 小时）先问 GitHub 接口
  `openai/plugins` 的 main 是哪个提交，变了才下那个提交的压缩包，核提交号、路径、两份市场清单（与客户端同一套规矩）
  后传到 `xingmang/offline/codex-plugins/sha256-<摘要>/`，最后改 `latest.json`。沿用 `xingmang/*` 的权限，
  不用新密钥；连续失败两次照样开 issue 报警（`cos-sync-alert.cjs` 加了这条工作流和它自己的「影响」说法）。
- 客户端新模块 `electron/codex-plugin-catalog-bucket.ts`：桶地址与清单路径写死，清单里的路径、地址、大小、
  SHA-256、类型、校验标签一处对不上就不用；不跟跳转；过了头半分钟照当时速度还要 2 分钟以上、或半分钟没数据就放弃。
  解开后照 GitHub 那一份的规矩再核，压缩包里的提交号还要和清单一致。没走通悄悄改去 GitHub，原因只进运行日志
  （`codex-plugin-catalog.bucket-fallback`）；下载加速线路改成只在去 GitHub 时才借。界面文字没有改。
