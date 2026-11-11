## 开发

- Fable 手机遥控 YF-15：长任务中途给进度，字是 yoyo 2026-11-11「进度改」批的那版（`codex-remote-text.ts` 的
  `progressCardTitles` / `progressStepMarks` / `progressStopButton` / `progressTextMessage` / `staleProgressCard`）。
  渠道接口多两个可选方法 `sendProgress` / `updateProgress`（`codex-remote-channel.ts`），只有飞书实现：Codex 报了计划
  （`turn/plan/updated`）或这一轮满 2 分钟发一张 `update_multi` 的消息卡片，之后用
  `PATCH /open-apis/im/v1/messages/:message_id` 原地更新（换步骤最快 30 秒一次，同一步每 5 分钟刷一次时间），做完、
  停了、没做完时改标题、去掉时间和按钮。更新用的是第 3 步已开的「以应用的身份发消息」权限，不用多开。消息编号拼进路径前
  先过 `om_` 正则。卡片上的「停止」带这一轮的随机串（`value.stop`），进来是新的 `RemoteInbound` 种类 `stop`，跟审批卡
  一样只认绑定的人、只认私聊；随机串对不上（上一轮留下的卡）不停这一轮。微信没有能更新的卡片，每满 5 分钟发一句，等同意时不发。
  进度的发送和更新都排在这一轮自己的一条链上（`TurnState.progress.chain`），最后那次「做完了」不会被晚到的更新盖掉；
  更新失败只记 `remote.progress-failed`，不影响回答。每处收尾改走 `settleTurn`（`settleLastRequest` + 收尾进度卡）。
  不加 IPC 通道，星芒电脑上的界面不变。用户行并在 `codex-remote-fixes-0224.md`。
