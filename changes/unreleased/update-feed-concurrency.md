## 开发

- #492（D18）：正式发布的 publish 作业、rollback-release、service-status 三处写更新目录的作业改为共用 `update-feed` 并发组（挂在作业上，出包阶段不受影响）。原先发布用 `publish-release`、回滚与维护开关用 `service-status` 两个组，发布与回滚可以在「读线上 → 写回」之间交错，互相盖掉清单，撤回名单与线上版本对不上。`scripts/publish-workflow-config.test.cjs` 扫描全部工作流，凡是 `aws s3` 写入的作业都必须在这个组里。
