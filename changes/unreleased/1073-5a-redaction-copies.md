## 开发

- 服务器报错的清洗只留一份：`connection-check.ts` 的 `sanitizeUpstreamDetail` 和 `new-api-client.ts`
  的 `sanitizeUpstreamMessage` 逐字相同，合成 `command-runner.ts` 里紧挨 `redactCommandText` 的
  `sanitizeUpstreamDetail`（`redaction-patterns.ts` 不许有 import，放不进去）。主目录的各种写法也只列一份：
  `startup-log.ts` 的 `pathRootSpellings`，运行日志的 `redactHomeDirectory` 和诊断导出的
  `redactRootPaths` 都用它，运行日志因此也认出 `C:\/Users\/…` 这种转义斜杠写法。两边换成什么标签、
  路径边界怎么判照旧（#1073 第 5 条 a）。
