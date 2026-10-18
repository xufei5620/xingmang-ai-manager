## 开发

- 读 `.env` 某一行只留一份：`config-files.ts` 的 `readEnvValue` 改调 `tool-route-rewrite.ts` 的
  `readEnvLineValue`（原先逐字抄了一份），读出来的值不变，没有这一行照旧当空。后台计时只留一份：
  线路切换、系统代理复查、加速到期和中断提醒五处各抄的 `scheduleTimeout` 收进
  `schedule-timeout.ts`，几点触发不变；两个加速提醒原先没 `unref`，现在也跟着 `unref`，在主进程里
  不影响触发和退出。测试另钉住只此一份（#1073 第 6 条）。
