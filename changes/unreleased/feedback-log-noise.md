## 开发

- 反馈报告附的最近 600 条日志不再被刷屏（第二十六批 B）。两份真机报告里，Windows 那份有 505 条是下载更新时
  每秒一条的「主程序更新状态：downloading」，Mac 那份有 508 条是公告、公告已读同步、订阅三个轮询的「完成」行，
  更早发生的事反倒被挤出了报告。
- 更新状态那条日志（`electron/update-state-log.ts`，由 `main.ts` 的 `broadcastUpdate` 调用）：只在阶段、找到的版本、
  错误、失败步骤变了，或下载进度过了一档 10% 时记；下载中那条带整数 `percent`。一次下载从五百多条变成十来条，
  界面照常收到每一份快照。
- `electron/ipc.ts`：`account:get-notice`、`account:sync-local-notice-reads`、`account:get-subscription-self` 成功改记调试级
  （照样写进本机日志文件，只是报告不附）。耗时 3 秒以上的、上一次失败之后的第一次成功照记 info，后者带
  `recovered: true`；失败照旧记 error。
- `electron/runtime-log.ts`：日志摘要另留一段只含调试级以外的尾部（`nonDebugEntries`，同样最多 2000 条），
  反馈报告从这里取。以前从全部级别的最近 2000 条里再筛掉调试级，调试级一多，报告就附不满 600 条。
