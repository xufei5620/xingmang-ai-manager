## 用户

- 「备份迁移」中损坏的备份将单独列出并标明不可用，可直接删除。

## 开发

- R2-2（总单 70）：`ConfigBackupStore.list()` 校验没过的那份，清单还读得出来时带上工具、原因和时间，读不出来时时间退回目录名里的那个（`resolveBackupIdTime`）；已下线工具的坏备份因此照旧由 `backups:list` 筛掉。renderer-v2 `BackupCard` 改用 `visibleBackups`：认不出工具的坏备份只在「全部工具」里，坏的那行不给「预览」、「恢复」灰着、能删；没有时间的删除确认写「删除这份备份？」。主进程的原因文字带路径和文件名，不上屏。`storage-usage-service` 的「清理旧备份」只数、只删校验过的，行为不变。
