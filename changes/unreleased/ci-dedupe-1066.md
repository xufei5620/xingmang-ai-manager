## 开发

- `quality.yml` 不再把 renderer-v2 和画布的单元测试跑第二遍（#1066）：`test:vitest` 的 `src` 参数按路径子串已经收进 `src/renderer-v2` 和 `canvas-v2/src`，Windows 的三个 vitest 分片和 Linux、macOS 的 `npm test` 本来就跑全了，所以删掉 Windows 的 `renderer-v2` 分片和 Linux 的 `test:v2:vitest`、`test:canvas` 两步，`npm test` 本身不变。每个平台每个测试文件仍跑一次；`scripts/ci-workflow-config.test.cjs` 按 vitest 的过滤规则证明 `test:vitest` 包含这两套，并挡住有人再加回来。
