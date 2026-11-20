## 开发

- Windows `vitest-2` 分片两天里两次撞 15 分钟上限（#1946、#2000，#2006）：`electron/external-client-service.test.ts`
  一个文件 138 条、在 Windows 上占 170~300 秒，分片拆不开，跑道慢一阵就把那一片推过上限。按 describe 拆成四个文件
  （原文件加 `.route-follow`、`.key-follow`、`.account-follow`），夹具挪进 `external-client-service.test-support.ts`，
  136 条用例名字和结果一条不差；`scripts/vitest-shards.mjs` 用时表按 #1972 之后五次 main 的中位数重量，同样五次下四片各
  9.2~9.9 分钟。「shows the next start the last whole detection…」不再用 `vi.waitFor` 读文件等上次检测结果落盘（默认只等
  1 秒），改成包一层 `writeAtomicSafeUtf8File` 等那次原子写本身。上限、片数、超时都没动，没跳过测试。
