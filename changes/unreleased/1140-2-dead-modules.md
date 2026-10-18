## 开发

- 删掉 6 个只有自己的测试在用、生产代码从不引用的模块：`electron/canvas-account-lifecycle.ts`（账号切换的取消与初始化
  早已直接写在 `main.ts` 里）、`electron/platform/facade.ts` / `registry.ts` / `index.ts`（渲染层的平台能力走
  `platform:get-capabilities`），以及 renderer-v2 的两个桶文件 `src/renderer-v2/index.ts`、`src/renderer-v2/registry/index.ts`；
  `electron/platform/types.ts` 只留 `zoom.ts` 还在用的 `UiScalePreference`，模块地图同步（#1140 第 2 条）。
