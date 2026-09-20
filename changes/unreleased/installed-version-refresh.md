## 用户

- 装完或更新完一个工具后，工具行会一直显示「安装完成，正在同步账号 Key 并刷新状态」，
  直到最新版本号真的读出来为止，不会中途闪回旧版本号和「更新」按钮。

## 开发

- `src/renderer-v2/App.tsx`：把装完之后的 `syncAfterToolInstalled`（写账号 Key + 重新检测）
  挪进 `toolbox.run` 的同一个任务里。此前安装 IPC 一返回任务就结束，工具行随即回落到
  安装前的快照，在同步 Key 和两次重新检测跑完之前一直显示旧版本号并重新挂出「更新」
  按钮（yoyo 2026-09-20 Windows 真机反馈①，Codex 桌面端与四个 CLI 同一条路径）。
- `useToolbox` 的 `run` 现在把一个 `report(label)` 回调交给操作本身，长任务可以在途中
  改写工具行上那句话；进度事件那条既有通道不变。
- `src/renderer-v2/testing/app-fixture.tsx` 新增 `cliUpdate` 查询参数与
  `holdNextScan` / `releaseScan`，`app-check.mjs` 用它们钉住这一段：重新检测落地之前
  工具行不得放回「更新」按钮或旧版本号。
