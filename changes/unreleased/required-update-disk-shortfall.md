## 用户

- 软件要求必须更新、而电脑磁盘又快满时，更新提示会直接说清「只剩多少、要多少、还差多少」，
  教你怎么清理；清出空间后点「空间够了，再试一次」就行，不会再出现点「立即更新」没反应的情况。

## 开发

- 修 #698 强制更新门与 #683 下载前量盘没接上：`updater.ts` 的 `download()` 量盘不够时只挂
  `diskShortfall`、不抛错，门却照旧给「立即更新」，点了没有任何变化。`required-update.ts` 读
  `diskShortfall`（按钮改「空间够了，再试一次」，不自动接着下）；`RequiredUpdateGate.tsx` 复用
  更新页的缺口说法、清理步骤与「仍要下载」（`ignoreDiskSpace`）；清理步骤从
  `registry/tutorials.ts` 拆出 `updateDiskCleanupSteps`，门里不说「回到更新页」。
