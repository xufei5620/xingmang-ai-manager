## 开发

- CI：`quality` 工作流的 `linux-test` 原先把 typecheck、`npm test`、`test:v2`、`test:ui` 等一路排队跑完，约 21 分钟，
  是整条流水线最慢的一项（别的作业约 14 分钟内都已跑完）。`test:v2` 的夹具浏览器套件（`test:v2:browser:fixture`，
  约 11 分钟）改到新作业 `linux-renderer-v2-browser` 与它同时跑，切法与 Windows 分片相同、不再往细拆（共用同一份
  Vite 依赖预构建缓存）；`linux-test` 改跑 `test:v2:vitest` 与 `test:v2:browser:e2e`。一项检查没少、也没重复跑，
  新作业已进 `quality-gate`。`scripts/ci-workflow-config.test.cjs` 钉住两个作业合起来正好等于 `npm run test:v2`。
