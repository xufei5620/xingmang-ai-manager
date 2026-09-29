## 用户

- Windows 上从星芒打开 Codex 桌面端时，工具行每 5 秒说一句等了多久、在等什么；等了 20 秒还没出来，会提醒你先去开始菜单看看它有没有自己弹出来。
- 等满了还没打开时，提示会说清等了多少秒、Codex 是「启动了但窗口没出来」还是「根本没启动」，并教你一个自己就能判断的办法：在开始菜单里直接点开 Codex，也起不来就是 Codex 这一版自己的问题，可以等微软商店更新它或先用 Codex CLI。

## 开发

- 新增事件通道 `desktop:codex-launch-progress`（`onCodexDesktopLaunchProgress`，载荷 `CodexDesktopLaunchProgress`）：Windows 打开 / 重启桌面端时由 `startCodexDesktopLaunchHeartbeat` 每 5 秒发一次，分「准备」「等窗口」两段文案（`describeCodexDesktopLaunchWait`），渲染层把它写进 `launch:codexDesktop` 那个任务的进度句。等待时长与启动逻辑不变。
- `describeCodexDesktopLaunchFailure` 多一个可选的 `{ waitedSeconds, processSeen }`：带上时按激活有没有交回进程号分两句，并附开始菜单自查法；开头仍是 `codexDesktopNotStartedPrefix`，渲染层归类不变。
