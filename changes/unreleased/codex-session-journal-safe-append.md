## 用户

- 归档、恢复 Codex 会话时写的操作记录更安全了：记录文件如果被换成指向别的文件的链接，软件会停下这次操作并提示，不会再把记录写进别的文件；等记录文件恢复正常后，下次操作会先把上次没完成的归档补完再继续。

## 开发

- `safe-local-data.ts` 新增 `appendSafeUtf8FileSync`，两个追加函数都多了可选 `{ durable }`（写完 fsync），与异步版同一套单链接、无重定向、打开后复核的边界。
- `codex-sessions.ts` 的 `appendJournal` / `appendJournalSync` 改走上面两个函数，不再裸 `open(..., 'a')`（#536，codex-win F01）。
- 启动时操作日志安全读取失败会记下来；之后每次归档/恢复前先重试启动恢复，仍读不了、或日志变成硬链接/重定向时直接拒绝，不建备份、不动 SQLite 和 JSONL。
- 测试夹具的临时目录改用 `realpathSync.native`，macOS 的 `/var` 别名与 Windows 8.3 短名不会被新的路径组件检查误拒。
