## 开发

- `scripts/audit-development-dependencies.cjs` 给 picomatch 的 GHSA-fc5q-39xc-vjpf（ReDoS，高危）开了一条窄例外，
  到北京时间 2026-12-15 当天结束（yoyo 11-18 打字同意）。公告范围 `<=4.0.7` 覆盖 picomatch 发过的每一版，上游修复
  micromatch/picomatch#194 还没合，vite / vitest / tinyglobby 最新版仍要 `^4`，没有能升或能换的版本；
  它只经 vite、vitest、tinyglobby、fdir、node-gyp 进开发依赖，`audit:production` 0 条，
  自家 vite / vitest 配置里也没有触发它要的 extglob 规则。
- 同时收紧放行判断：每个受影响包的严重程度不能超过它实际连到的那条公告，不再用整张例外表里最高的上限，
  免得 picomatch 的「高危」上限顺带放宽只连到 minimatch（中危）的那条链。
