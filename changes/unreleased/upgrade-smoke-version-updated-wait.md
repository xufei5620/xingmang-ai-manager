## 开发

- 升级冒烟（`scripts/upgrade-smoke.cjs`）看到 `last-run-version.json` 后，`version.updated` 那一行也等最多 30 秒再判：
  这一行是排队异步写进运行日志的，常常比 `last-run-version.json` 晚落盘，以前只查一次会偶发误报
  「新版本没有记下『本次启动是更新后的第一次』」（#1565、#1748 上的 windows-upgrade 0.2.19）。
