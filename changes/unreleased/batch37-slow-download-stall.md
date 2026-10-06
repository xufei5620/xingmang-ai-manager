## 用户

- 网速慢的时候装或更新 Claude Code、Codex，不会再下到 5 分钟就被打断、换个下载源从头再下，结果怎么点都装不上：
  只要还在下，星芒就一直等，最长 30 分钟；真的 3 分钟一点没动，才换下一个下载源，提示还是原来那句「下载超时」。
  一个下载源没下成时，先把它下了一半的东西删掉再换源，磁盘快满的电脑更容易装上。

## 开发

- 第三十七批 A：`npm ci` 那一步以前用 `npmDownloadTimeoutMs`（5 分钟）当总时长，命令运行器到点就结束整棵进程；每个源、每次安装
  都用新的 attempt-N 目录和缓存，所以换源、重试都从零开始，每秒不到 0.3～0.5 MB 的客户永远下不完（Claude Code 约 100 MB、
  Codex 约 130～160 MB）。npm 自己不掐慢而不断的下载（@npmcli/agent 的 fetch-timeout 管的是连接空闲多久）。
- 现在这一步看进展：`createNpmDownloadStallWatch` 每 `npmDownloadProgressCheckMs`（15 秒）用 `measureDirectoryBytes` 量一次这一轮的
  attempt-N 目录（不跟链接和目录联接、顺序走，根目录读不了就报错、不当成 0），大小连续 `npmDownloadStallTimeoutMs`（3 分钟）没变才中止，`npmDownloadCeilingMs`
  （30 分钟）交给命令运行器当总上限兜底。make-fetch-happen 边下边把数据分一路写进 cacache 的临时文件、tar 边读边解进 node_modules，
  目录大小就是 npm 不打印的进度；变小也算在动（npm 自己重试前会丢掉下坏的半截），量不出来的那一拍也算在动，时钟用单调的
  `performance.now()`。`executeNpm` 加一个可选的 signal，和取消信号用 `AbortSignal.any` 合在一起；是看门狗掐的就抛
  「下载超时，长时间没有完成，已中止」（和 TIMED_OUT 共用一个常量），后面换源、拼报错、渲染层归成「下载超时」都不变；客户点取消照旧报
  「安装已取消」。卡住被掐时运行日志记 `cli.install.download-stalled`（源、已用时、目录大小）。
- 后面带 `--offline` 的「装到本机」那一步不动，还是 5 分钟。一个源失败后先删掉它的 attempt-N 目录再换下一个源，删不掉就留给
  结束时的 finally。没有改 `command-runner.ts`，没有新写界面文字（下载时的进度提示是第三十七批 D，要另外点头）。
