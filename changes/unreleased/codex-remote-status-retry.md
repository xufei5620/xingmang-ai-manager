## 开发

- Fable 手机遥控 YF-18、YF-22、YF-16（「状态重试」那批）：
  - 「状态」最多四行（`statusMessage`）：「现在」带上这一轮跑了多久（`TurnState.startedAt`）和 Codex 计划里正在做的那一步
    （`turn/plan/updated` 里第一条 `inProgress`，`currentPlanStep`），再加余额（`readBalanceUsd`，main.ts 接画布余额条那份
    读取器，最多等 3 秒）和「再过 N 小时没新消息就自动关」（选了不自动关就没有）。读不到的那一样整行不写。
  - 新指令「重试」：把这次打开以后最后一句交给 Codex 的话（`ChannelRuntime.lastPrompt`，只在内存里，打开渠道、换人时清掉）
    再发一次，「收到」前面先说「再发一次上一条：「前 20 个字…」」；没有就回 `remoteMessages.nothingToRetry`。「帮助」第二行列上它。
  - 做完（`completed`）的回答后面空一行接 `turnSummaryLine`：用时，和这一轮真改成了的文件（`fileChange` 条目 `completed`，
    去重，只写文件名，最多列 3 个）。停下、没做完的不接。
