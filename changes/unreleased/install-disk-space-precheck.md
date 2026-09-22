## 用户

- 装工具前先看一眼磁盘剩余空间：不到 1 GB 时直接提示「磁盘空间不够」，不再让安装跑到
  一半才失败。
- 「检查」页新增「磁盘空间」一项，写明工具安装目录和软件数据目录所在磁盘还剩多少；
  低于 2 GB 会提醒先清理一些。

## 开发

- 新增 `electron/disk-space.ts`：`fs.statfs` 读剩余空间，目标目录还不存在时向上退到最近
  一级存在的目录再问；读不到一律返回 null（fail-open），不为一个查不到的数字拦下安装。
  另 `fs.stat` 取设备号，用来把同一块盘上的两处目录合成一条。
- `system-service.ts` 的 `installCliOperation` 在起任何子进程之前预检临时事务目录与托管
  目录两块盘，取更紧的那一块；低于 1 GB 抛出带「磁盘空间不足」的中文错误，由
  `src/renderer-v2/operation-error.ts` 已有的 `diskFull` 一类呈现，不新增分类。
  `codex-desktop-service.ts` 经新的 `assertInstallDiskSpace` 选项复用同一条门槛。
- `diagnostics.ts` 新增 `DISK_SPACE` 检查项：看 CLI 落点（托管目录）与主进程注入的
  `userDataDirectory`，同盘只报一条，低于 1 GB 记 `fail`、低于 2 GB 记 `warn`，
  `statfs` 读不到记 `warn`「未能读取」而不是失败。未新增 IPC 通道。
