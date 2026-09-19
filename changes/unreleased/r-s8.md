## 用户

- 某一份命令行工具的配置文件损坏时，首页不再整块空白：工具列表、安装和卸载照常可用，页面上方写明是哪一块没读到及其原因，工具行显示「配置暂未读到」并提供「重新配置」按钮。

## 开发

- 工具页（renderer-v2）的一次读取从 `Promise.all` 改为 `Promise.allSettled`，对齐 legacy
  `scan-coordinator.ts` 的「部分成功也提交」：`createToolsApi().read()` 返回 `{ snapshot, failures }`，
  config 那一块读失败时用占位表降级而不再连坐整页（system / platform 缺失仍返回 null，那两块就是工具列表本身）；
  失败原因统一走 `business-common` 的 `errorMessage` 脱敏。`useToolbox` 新增 `failures`，`Home` 把分区失败
  作为 alert 展示并把工具行的连接状态标为 `configUnavailable`（而不是谎报「还没配 Key」）；`app-check.mjs`
  里原来一份两用的失败用例拆成 scanSystem（仍抛错 + toast）与 getConfig（降级 + 页内提示）两条（审查总表 R-S8）。
