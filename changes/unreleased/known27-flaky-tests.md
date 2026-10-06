## 开发

- 客户恢复脚本 `scripts/windows-acceleration-recovery.ps1` 的还原逻辑检查（全部读写都是假的、不碰真代理）
  从 `test:scripts` 挪到 Windows 打包作业的 `e2e/windows-powershell-probes-smoke.mjs`。它原来在 node --test
  分片里和几十个套件同时跑，冷启动的 Windows PowerShell 在 #782 上把 30 秒用完、一条检查都没红。
  `scripts/` 下两条只读源码的检查（无 BOM、和软件那份 WinInet 脚本逐字一致）留在原处；
  `ci-workflow-config.test.cjs` 那条「单元测试不起真 PowerShell」的门禁扩到 `scripts/*.test.cjs`。
- `acceleration-development-host.test.ts`「父进程突然退出后辅助进程照样收尾」那条不再自带三个墙钟期限
  （父进程 4 秒内退、3 秒内写出 restored、假辅助进程 5 秒自尽），改成按事件等，只由用例自己的 10 秒上限兜底。
  10-1 在沙箱整套 `npm test` 里偶红过；这次在沙箱压满 CPU 跑了 50 多轮没复现，这是全文件唯一靠墙钟判输赢的用例。
