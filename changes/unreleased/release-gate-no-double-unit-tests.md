## 开发

- 发版门禁不再把出货渲染层和画布的单测跑两遍：`scripts/run-release-build.cjs`（Windows 出包）和 `publish-release.yml` 的
  `linux-checks` 原来在 `npm test` 之后又整条跑 `test:v2`、`test:canvas`，而 `test:vitest` 的 `src` 早把 `src/renderer-v2`、
  `canvas-v2/src` 挑进去了（#1066 在 CI 那边查明并去掉）。现在只补 `npm test` 不跑的 `test:v2:browser`，`test:ui` 照旧；
  门禁步骤 14 → 13，`run-release-build.test.cjs`、`ci-workflow-config.test.cjs`、`publish-workflow-config.test.cjs` 钉住不再重跑。
