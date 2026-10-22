## 开发

- 依赖锁文件把 vitest 及同套 `@vitest/*` 从 4.1.11 升到 4.1.12（`package.json` 的范围跟着抬到 `^4.1.12`），修掉新出的 2 条公告让 CI 构建依赖审计报红：`@vitest/mocker` 的 GHSA-qxg6-89mg-rqv8、GHSA-xp26-3454-mjgp（修复版 4.1.12）。纯开发依赖，不进安装包，锁文件里别的包没动。`canvas-v2/` 自己的锁文件 CI 不审，这次不碰。
