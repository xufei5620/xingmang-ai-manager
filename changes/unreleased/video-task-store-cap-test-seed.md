## 开发

- 测试：`electron/ai-video-task-store.test.ts`「keeps only the newest finished requests」和「keeps only the newest unclear requests and drops a damaged one on its own」原来经 store 一条条存满 100 条上限再多存一条，等于 101 次带路径检查和刷盘的原子写；Windows runner 上一次几十到三百多毫秒，#1513 的 `windows-test (vitest-1)` 一条撞过 30 秒、另一条跑了 17.8 秒。改成把上限前那 100 条（新的在前，跟 store 写的顺序一样）直接写进文件，只让越过上限的那一条经过 store，另加一句「正好在上限时一条不丢」。断言照旧，不调超时，产品代码不动。
