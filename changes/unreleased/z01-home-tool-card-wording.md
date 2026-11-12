## 开发

- 0.2.24 深查改字批次 Z01（首页和工具卡），yoyo 11-10 回「按照你的推荐做」批的 W7 W9b W10 W11a W12b W19 W25 W26 W27 W28 W29 W65 D12，
  只换单子上逐字写的字，测试里写死的字跟着改。D12：`Home.tsx` 页头在「还没连上」之后、「还没装工具」之前加一支
  `undetectedCount > 0`，检测失败的卡 `installed` 为假，原来会落到「都配好了」（全都没检测出来时落到「还没装工具」）。
  `registry/status.ts` 的 `environment.optional` 跟着改成「可选 · 未安装」，`ui-spec/22-registries.md` 同步。
  用户那条等这批改字都合完由协调者统一补一条（「## 用户」已 53 条，上限 60）。
