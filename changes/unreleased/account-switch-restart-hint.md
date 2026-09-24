## 用户

- 换账号之后，只提醒真的还开着的工具「关掉重开才会用上当前账号」，没开着的不再每次都念一遍；Windows 上 Codex 桌面端还开着时给一颗「帮我重开」按钮，点了才重开。在账号之间切换以前没有这句提醒，现在也有了。

## 开发

- 新增 `electron/running-tools.ts`（按实际安装位置认进程、逐个检测、文案生成）与只读通道 `tools:inspect-running`；首页一键切换账号来源（`account-source-switch.ts` 的 `inspectRunning` 依赖）和保存账号之间切换（`account-switch-sync.ts`）写完配置后都走它，检测失败退回「如果还开着」的说法；桌面端重开复用 `desktop:launch-codex` 的 restart。
