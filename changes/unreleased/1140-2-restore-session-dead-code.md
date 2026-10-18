## 开发

- 删掉 `electron/account-session-store.ts` 里只剩测试在用的 `restoreAccountSessionOnStartup`：开机恢复登录早已改成
  `realm-account-service.ts` 的 `restoreActive`，这个老文件只在第一次升级时读一次做迁移。`ipc.ts`、`ipc.test.ts`、
  `new-api-client.ts` 里按它写的注释改成现在的走法，模块地图同步（#1140 第 2 条补充）。
