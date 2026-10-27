## 开发

- 清掉主进程和 v2 界面里四十来处声明了却没人用的 import、类型、变量和一个内部函数（`config-save-service.ts` 的
  `cliHooksStale`），大头是拆页面后 `pages-account.tsx` 留下的 30 多处；不改任何行为（仓库清单 G19）。
  三处故意留着的「类型钉子」（`system-snapshot-cache.ts`、`external-client-snapshot-cache.ts`）不动。
