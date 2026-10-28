## 开发

- 用量看板按型号分桶汇总时，每个时间桶的型号表改用无原型对象（`electron/new-api-client.ts` 的
  `parseAccountDashboardData`），服务端回来的型号名只当普通键用，碰不到主进程里共享的内置对象。
  审查总表 S04（#1489）。
