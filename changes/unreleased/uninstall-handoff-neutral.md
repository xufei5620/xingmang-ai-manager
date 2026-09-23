## 用户

- 以管理员身份打开本软件时卸载工具，软件会另开一个普通窗口去卸载。以前这一步会弹出红色的「操作没有完成」，看着像出错了；现在只给一条普通提示，告诉你在新开的窗口里卸载完，再回来点「重新检测」。首页和「安装卸载」页都一样。

## 开发

- 全面检测 Q49。卸载结果 `outcome: 'delegated'`（管理员模式转交给以登录用户身份运行的窗口）是预料之中的交接，原来首页 `App.tsx` 的 `requestUninstall` 抛错走 `OperationErrorDialog`，安装卸载页 `MaintenancePage` 也抛错显示红色「未完成」。新增纯函数 `features/tools/uninstall-handoff.ts` 的 `uninstallHandOffNotice`，两处改为关掉确认框、刷新状态、弹中性 toast，不再当失败；`manual-required` 仍按失败处理不变。
