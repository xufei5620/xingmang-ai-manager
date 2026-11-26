## 开发

- 首页工具区「已安装 N 个」和状态栏「已装 N 个工具」以前各数各的：首页算了 Antigravity 两张卡和正在装的，状态栏没算，
  同一屏一个写 5、一个写 3。两处改用 `features/tools/installed-count.ts` 的 `installedToolCount`，按首页工具区摆出来的卡数
  （命令行工具和 Codex 桌面端、外部客户端、Antigravity 两张，已装好的加正在装的）。不出新字。
