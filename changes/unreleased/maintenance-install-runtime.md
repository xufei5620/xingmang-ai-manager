## 用户

- 「安装卸载」页点「安装」也会先把缺的运行环境装好，不再只报「请先安装 Node.js」；装完同样自动写好当前账号的 Key。
- 正在装一个工具时点「打开」另一个，工具行会写清在等谁装完，装完马上打开，不再一直转「正在打开工具」。

## 开发

- 全面检测 Q33、Q15。`BusinessActions` 新增可选 `installTool` / `cancelToolInstall`，App 传入首页那条 `install`（先备运行环境 → 装工具 → `syncAfterToolInstalled`）和 `toolbox.cancel`；维护页有它们就只走这一条，没有时保留旧的直连路径。App 的 `install` 改为返回 `ToolInstallOutcome`（installed / restart / skipped），维护页据此给结果文案（`installResultMessage`）。
- 维护页的安装因此也登记进 `toolbox.jobs`，`launchWaitLabel`（`features/tools/launch-notice.ts`）据此在「打开」排队时写出前面那一项的名字；主进程队列与 IPC 未改。
