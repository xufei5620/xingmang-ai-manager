## 开发

- Windows CI 四个 vitest 分片的用时表（`scripts/vitest-shards.mjs`）按 11-20 五次 main 的中位数重量：11-19 那份把 config-files、
  system-service 记多了，把落在同一片的 claude-desktop-config、tool-config-ownership、codex-remote-service、backups 记少了
  （记 280 秒、实际 390 秒），那一片五次里四次跑到 11.7~12.7 分钟，别的片多数 8~11 分钟。秒数改量「这个文件在日志里占了几秒」
  （跟上一行的时间差，含加载），表收到 5 秒以上的 57 个文件，其余每个按 0.6 秒。按同样五次的中位数算，四片各 9.8~10.0 分钟。
  外部客户端、写配置这类大量写文件的套件在慢机器上会慢一半（同一个文件 182 秒对 287 秒），单次某片偶尔长一两分钟是机器，不是分组。
