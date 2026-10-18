## 开发

- 新增 `scripts/verify-drama-parse-parity.test.cjs`，逐字钉住 `electron/` 与 `canvas-v2/src/library/` 下
  `drama-model.ts`、`drama-parse.ts`、`drama-parse-prompt.ts` 三对副本：主进程解析模型回复后存成节点输出，
  画布再用自己那份解析一遍弹确认框，两份分叉会让主进程判成功的表在画布报「结果无法转成四表」。另钉住这三份
  只互相 import，以及主进程与画布之间不再出现没登记的逐字副本（#1140 第 4 条）。只加测试，两边源码未改。
