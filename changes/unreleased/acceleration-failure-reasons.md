## 用户

- 游戏加速读不到状态时，提示不再是千篇一律的「加速服务暂不可用，请稍后重试」，而是说清楚卡在哪一步：
  系统临时文件夹不可用、上次加速没退干净还占着网络设置、本机策略不让改网络设置、本机时长记录读写失败等，
  每一句都带上用户自己能做的下一步。
- 这条提示旁边多了「查看日志」，一键跳到反馈页的运行日志，不用再自己去找日志文件夹。

## 开发

- `acceleration-contract.ts` 新增封闭的失败原因集合 `accelerationFailureReasons` 与对应中文文案，
  连同 `withAccelerationReason` / `accelerationFailureReason` 两个工具。跨进程只传原因名，不传错误原文
  （与 `AccelerationStartFailureStage` 同一条 I13 约束）。
- `acceleration-development-worker.ts` 在失败应答里带上 `classifyAccelerationWorkerFailure` 归出来的原因；
  `acceleration-development-host.ts` 校验后挂到自己抛出的错误上。`acceleration-service.ts` 不再把所有后端
  失败收成 `BACKEND_FAILURE`，认不出的才保留原来那句话。
- `ensureReady` 里「准备辅助进程工作目录」与「拉起进程」原来共用一个 `try/catch`，errno 和原文一起吞掉：
  一台永远起不来的机器在 `runtime.jsonl` 里只剩「本机加速进程启动失败。」，定位只能靠反编译压缩产物数
  字节（2026-09-22 客户机）。现在两步各自接住，经新的 `onHelperFailure` 回调记到 `acceleration.helper.failed`，
  带上原因、errno 与底层错误；`ipc.ts` 的失败日志另加 `accelerationReason` 字段便于检索。
- `AccelerationView.tsx` 的错误条按 `operationLogPage` 的既有口径给出「查看日志」入口（加速没有 `tool`，
  永远落反馈页），落点规则不另写一份。
