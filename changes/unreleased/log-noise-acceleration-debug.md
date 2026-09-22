## 用户

- 开着加速页时，软件不再每 15 秒往日志里写一条一模一样的「读取加速状态」；反馈报告也不再附带这类调试记录，客服拿到的是登录、写 Key、打开工具这些真正有用的内容。电脑上的日志文件照常完整保留。

## 开发

- `ipc.ts`：`acceleration:get-state` 的成功日志按 `accelerationStateLogKey`（scope、阶段、模式、授权来源、线路、连上时间、错误、冲突）去重，只在状态变化时记；剩余时长每秒在走，不算变化。失败照常每次都记。
- `runtime-log.ts`：`snapshot(limit, { excludeDebug })` 新增可选过滤，只影响附带条目，总数与分级计数仍按全部日志算；`captureFeedbackReport` 默认排除 debug，「日志条数」一行注明「调试级 N 条未附」。debug 仍然落盘，没有改轮转和日志页列表。
