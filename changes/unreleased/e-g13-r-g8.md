## 开发

- E-G13：`electron/external-client-runtime.ts` 的 macOS `/bin/ps` 探测改为显式 `trustedOnly: false`，
  与同一分支另外三处对齐。POSIX 上 `runCommand` 对这个开关只换环境、可信路径校验被静默丢弃，
  留着 `true` 等于替 macOS 宣称一个它拿不到的保证。新增 darwin 用例断言该分支每次执行都带
  `trustedOnly: false`。
- R-G8：订正 `src/provider-registry.ts` 两处与 rank 表对不上的顺序注释（概览序实为
  claude/codex/gemini/grok，与管理序的差异在头两位而非 Gemini/Grok），并写明这两套顺序只服务
  已冻结的 legacy 树；renderer-v2 自 v3.1.1 起统一为单一顺序，`registry/tools.test.ts` 新增用例
  钉住 `tools` 数组次序与 `shortcutIndex`。
- E-B13、T-B7：核实后无需改动——CLAUDE.md 的计数与 `vitest.config.ts` 表述已随 #172 的瘦身一并
  订正，文件顶部的维护约定现在明令不写计数；本次只删掉该约定里自己残留的行数计数。
  `ipc.test.ts` 已有对 `ipcInvokeChannels` 全量且顺序敏感的 `toEqual`，通道总数断言严格弱于它，
  不再重复添加。
