## 开发

- 「设置 › 备份迁移」最下面加「星芒占用的空间」卡（决定单 D100）：新通道 `storage:inspect` / `storage:clean`
  （`electron/ipc/handlers/storage.ts`，入参只认行名和清理对象，路径全由主进程定），
  主进程 `storage-usage.ts`（不跟链接的目录合计、六行共用一个并发闸、缩略图只删认得的文件名且单链接）
  与 `storage-usage-service.ts`（日志只记哪一行、字节数、几个没删掉）。
  「清理旧备份」只留卡上看得到的最近 10 份（`ConfigBackupStore.removeAllButNewest`）；
  「装工具时下载的文件」就是 `install-leftovers.ts` 认得的中断残留，算和删用同一套判断，
  手动清理进安装队列、不等 6 小时（Windows 以管理员方式运行时照旧等 6 小时，后台自动清理不变）。
  更新说明「## 用户」已到 60 条上限，这条不进更新页。
