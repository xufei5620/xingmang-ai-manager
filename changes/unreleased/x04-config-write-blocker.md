## 开发

- 修复批次 X04（决定单 D15，出处 0.2.24 深查 `权限和写失败.md` PW-3、PW-4，yoyo 11-10「按照你的推荐做」，不加按钮）：写工具配置撞上
  EACCES / EPERM 时，`config-files-context.ts` 的 `explainConfigWriteFailure` 先看是不是这两种：Mac、Linux 上工具的配置文件夹（或它下面到目标的
  某一层、目标文件）归 root（星芒自己不是 root 时才算）；Windows 上要盖掉的配置文件被设成了只读（mode 没有写位，只在写的时候算）。是就把报错换成
  「这个工具的设置文件夹归电脑管理员所有（错误码 EACCES）」或「这个文件被设成了只读（错误码 EPERM）」，原话挂在 cause 上进运行日志，code 照旧。
  `executeFilePlans`（含准备阶段）和写之前读原文的 `requireRawConfigText` 都走它；回滚也失败的那句照旧。
- 两种说法放在可进渲染层的新模块 `electron/config-write-blocker.ts`（已登记进 `verify-renderer-boundary`）；`operation-error.ts` 认出后配
  `registry/errors.ts` 新加的 `configAdminOwned`、`configReadOnly`：标题照旧「写不进配置文件」，正文是 D15 那两句，按钮照 `configPermission` 不加。
  查不出是哪一种的照旧是原来那句；切换前的备份那一步读不了不在这次里。
