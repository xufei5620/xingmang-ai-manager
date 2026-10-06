## 用户

- 在「安装卸载」页快装完时点「取消」、提示「这一步已经不能取消了。」以后，工具装完那条红条就收起，只提示「安装完成，
  工具状态已更新」，不再一直挂着「未完成」。

## 开发

- 第四十一批 B 的余项：`MaintenancePage` 取消被拒时把原因放进 `cancelNotice`，和检测失败、操作失败共用页顶那条
  `ResultNotice`（`resource.error || operation.error || cancelNotice`）。以前只在下一次点「安装」或「取消」时才清，装好以后
  红条一直挂着、旁边弹的却是「安装完成，工具状态已更新」；没装上时 `operation.error` 先盖住它，等下一次别的操作清掉
  `operation.error`，那句「这一步已经不能取消了。」又冒出来。
- `install` 两条路（接了 `installTool` 的、没接时自己调 `api.installCli` / `api.installCodexDesktop` 的）收尾的 `finally` 里
  一起清掉 `cancelNotice`，和那里已经在清的取消标记、「正在停止」是同一件事：这次安装结束了。不新写字。
- 测试：`testing/app-check.mjs` 接着第四十批 C 那条加一条浏览器回归：用 `holdNextScan` 停在「安装完成，正在同步账号 Key 并
  刷新状态」那几秒点「取消」，页顶写「这一步已经不能取消了。」；放开后弹「安装完成，工具状态已更新」，这一行写「已安装」，
  页顶不再有红条。换回改前的代码这条红。
