## 用户

- Windows 上安全软件或系统索引正好在扫配置文件的那一下，点「改用当前账号」、在配置窗口里保存、拨一下设置开关，
  不会再偶尔弹「写不进安装目录」「保存配置没有成功」、非得再点一次才好：星芒会自己等一小会儿再写一次。
  真写不进去时，提示和以前一样。

## 开发

- 第三十五批 B：Windows 上 Defender、索引服务正好开着目标文件或刚写好的临时文件时，「临时文件换过去」那一步会报
  EPERM / EACCES / EBUSY，过几十毫秒就好。`safe-local-data.ts` 早为画布自动保存在这一步加了重试，这次把那段循环抽成
  `renameWithTransientRetry`，另加同步版 `renameWithTransientRetrySync`（只在出错后用 `Atomics.wait` 等，最多共 300 毫秒），
  规矩不变（`isTransientReplaceError` 认的几种错误，等 20/40/80/160 毫秒，最多 5 次），用在 `config-files.ts` 的
  `executeFilePlans` 换文件、回滚两处和 `app-settings.ts` 换设置文件、换备份两处。
- 每次尝试前都重跑原来的路径检查（`assertSafeSourceAndTarget` / `assertSafeDataFile`），等的时候被换成联接、硬链接的照旧拒绝。
  5 次都失败就原样抛出最后那个错误，后面「写不进安装目录」这些说法和写进去的内容都不变。`writeAtomicSafeFile` 的行为不变
  （用尽后仍说「写入被系统占用」）。同类的 `backups.ts`、`claude-desktop-local-transaction.ts`、`codex-extensions.ts` 这次没动。
- 沙箱里用 Electron 43.6.0 确认过主进程能用 `Atomics.wait`（Linux）。
