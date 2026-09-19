## 开发

- `electron/codex-desktop-appx.test.ts` 里两条 Windows 专有用例的 PowerShell 等待不再写死 15 秒：
  改成一个有界、可用 `XINGMANG_POWERSHELL_TEST_TIMEOUT_MS` 覆盖的预算（默认 90 秒），
  理由与 `e2e/fixture-readiness.mjs` 的夹具预算相同——冷启一次 Windows PowerShell 5.1
  不是这两条用例要断言的东西，而 #174 把六个作业放上同一台 runner 之后 15 秒不够用。
  断言一字未改。同时在超时被杀时把预算写进错误消息：`execFile` 只在子进程非零退出时追加
  stderr，超时杀掉时消息只剩一行 `Command failed`，此前要靠反推才能判断是哪一种失败。
