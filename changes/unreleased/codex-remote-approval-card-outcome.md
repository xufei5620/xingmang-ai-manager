## 开发

- Fable 手机遥控 YK-8：飞书审批卡处理过以后原地变样（yoyo 2026-11-11「同意卡改」，去掉「回 同意 N」那句一并批了），标题换成「已同意 / 已拒绝 / 没回，已自动拒绝（第 N 条）」
  （`codex-remote-text.ts` 的 `approvalOutcomeTitle`），按钮去掉，正文去掉「回 同意 N」那句（`formatApprovalBody`）。
  渠道接口多两个可选方法 `sendApproval` / `updateApproval`，只有飞书实现，跟 YF-15 的进度卡共用发卡取 `message_id`、
  `PATCH` 原地更新那一套（`postCard` / `patchCard`）；审批卡因此一开始就是 `update_multi: true`。每处拒绝都改样子：
  卡片或文字回的、电脑上「都拒绝」、发「停止」一起拒掉的、这一轮结束剩下的；到点没回的写自动拒绝（`settle` 带
  `expired`）。星芒在退、渠道关了或换了连接就不改；改不成只记 `remote.approval-card-update-failed`，手机上那句文字照样发。
  旧版本发的卡不是共享卡片，改不了，样子照旧。用户行并在 `codex-remote-fixes-0224.md`。
