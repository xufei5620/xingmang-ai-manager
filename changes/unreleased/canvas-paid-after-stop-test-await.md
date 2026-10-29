## 开发

- 测试：`electron/canvas-project-asset-manager.test.ts`「puts a picture paid for before a stop into the paying account library with the stop tag」原来用 `vi.waitFor` 等「停止后收尾」回调，默认只等 1 秒；收尾要存图、打标签，都是带刷盘的原子写，#1515、#1534 的 `windows-test (vitest-3)` 撞过（调用次数 0，整条 1152 毫秒）。改成收尾回调和假 fetch 各自 resolve 一个 Promise、用例直接 await，发请求前那一处同样换掉。断言照旧，不调超时，产品代码不动。
