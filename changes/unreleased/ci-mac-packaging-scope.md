## 开发

- CI（仓库优化 G1）：`quality` 的 `macos-intel` 和 `macos-release-rehearsal` 在 PR 上只在动了打包相关文件时跑（名单在 `scripts/ci-change-scope.cjs` 的 `macPackagingFiles` / `macPackagingPatterns`，`ci-workflow-config.test.cjs` 顺着这两个作业的命令把它们加载的本地文件全找一遍、漏了就红），每次合进 `main` 照常跑。`macos-test` 不变，每个动代码的 PR 仍然出两个架构的包、启动 M 芯片版。10-24～10-26 的 PR 运行四分之三分位 41.9 分钟，去掉 Mac 作业是 14.0，多数 PR 从占 3 台 Mac 降到 1 台。
