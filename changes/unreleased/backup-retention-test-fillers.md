## 开发

- `backups.test.ts`「restores the oldest backup even when pruning runs at the retention limit」占满 200 份配额时，
  只整份复制要恢复的那一份，其余 199 份建空文件夹（prune 只按文件夹名数配额），再断言第二旧的那份被清掉。
  以前 200 份都整份复制，Windows runner 上这一段偶尔慢十几倍，11-22 在 main 上撞了 30 秒（#2084）。
  只改用例，产品代码没动。
