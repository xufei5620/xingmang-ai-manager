## 用户

- 修复 Codex 桌面端在首页一直显示「更新」按钮和「N 个有更新」的问题：已经通过微软商店更新到最新版、
  而国内镜像还没有同步新包时不再提示更新，避免点了也装不上。

## 开发

- 新界面对 Codex 桌面端的「可更新」判定重建为三态：`features/tools/model.ts` 新增 `codexDesktopUpdateKind`，
  `presentTools` 只在 `kind === 'installable'`（官方清单有新版**且** `mirrorUpdateAvailable === true`）时置
  `updateAvailable`。此前只读 `DesktopAppStatus.updateAvailable`，官方 MSIX 清单领先商店与国内镜像时，商店已
  更新到最新的用户会永远看到「更新」按钮和「N 个有更新」，而镜像没有包可装。legacy 的
  `src/codex-desktop-update.ts` 早已做过这个判定，v2 重写时没带过来；本次在 v2 内重建而非跨 renderer 引用
  legacy 文件，并补齐三态单测（R-S3）。
