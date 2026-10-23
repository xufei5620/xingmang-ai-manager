## 用户

- 顶部搜索「加速」只出一条「网络加速」，不再出两条去同一处的。

## 开发

- #1362 第 2 条：`command-search.ts` 的 `settingsEntries` 里，设置项跟所在组同名（加速卡「网络加速」与 `network` 组）时
  组那条不再单独出、这一行的结果名只写一遍；这一行被 `settingsItemVisible` 收掉时组照旧一条。`command-search.test.ts`
  补一条，「搬进设置的卡按旧页名找得到」那条跟着收紧成第一条就是加速卡。
