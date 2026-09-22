## 用户

- 反馈页的运行日志可以按来源筛选，也能勾「只看本次启动」，只看这次打开软件之后发生的事；
  日志详情里多了「复制这一条」，把出错的那一行直接发给客服。

## 开发

- `electron/runtime-log.ts` 的 `RuntimeLogSnapshot` 增加 `currentProcessId` 与 `startedAt`，
  随现有 `runtime-logs:list` 快照返回，不新增 IPC 通道；条目 id 里本来就带写入进程的 pid，
  配上启动时间才能排除 pid 被系统复用的旧条目。
- 新增 `src/renderer-v2/features/app/runtime-log-filter.ts`：纯函数 `filterRuntimeLogs` /
  `isCurrentBootEntry` / `runtimeLogSourceOptions` / `formatRuntimeLogEntry`，表驱动单测覆盖
  来源、本次启动与组合条件。
- `pages-maintenance.tsx` 的 FeedbackPage 用上主进程早就算好、渲染层一直没读的
  `snapshot.sources`；单条复制走渲染层 `navigator.clipboard.writeText`，内容是主进程已脱敏
  的日志行，与反馈报告里的单行格式一致。
