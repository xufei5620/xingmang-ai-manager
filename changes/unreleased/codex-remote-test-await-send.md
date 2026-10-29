## 开发

- 测试：`electron/codex-remote-service.test.ts` 共用的 `enabledAndPaired` 用 `vi.waitFor` 等「配对成功」，默认只等 1 秒；配对要先把绑定的人原子写进设置，#1542 的 `windows-test (vitest-3)` 撞过（`expected [] to include '配对成功…'`）。同文件里等审批卡片的 19 处同理（发卡片前要把编号写进盘）。改成假渠道在发出那一下 resolve（`FakeChannel.sentUntil`），用例直接 await；本地让设置每次写盘多等 1.5 秒，旧写法 37 条红、新写法全过。断言照旧，不调超时，产品代码不动。
