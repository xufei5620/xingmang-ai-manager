## 用户

- 「安装卸载」页在工具检测或系统信息只读到一半时不再把所有工具都标成「未安装」：页面上方写明是哪一块没读到及其原因，读不到状态的行显示「状态未读到」并提供「重新检测」，另一块读到的内容照常显示。

## 开发

- `MaintenancePage`（renderer-v2）自己那条读取路径原来是两个串行 `await`，任一块失败就让 `useResource` 的 `data` 保持 null，页面退回全 undefined 的渲染并把「未安装」「尚未安装」当成结论显示出来。新增 `features/tools/maintenance-status.ts`：`readMaintenanceStatus()` 用 `Promise.allSettled` 分别结算 `scanSystem` 与 `getPlatformCapabilities`，返回 `{ snapshot, capability, failures }`，失败原因走 `business-common` 的 `errorMessage` 脱敏（沿用 R-S7）。页面按分区渲染提示，`statusUnknown` 时工具行的状态标为「状态未读到」、主按钮换成「重新检测」，运行环境行显示「状态未读到」而不是「尚未安装」。与 R-S8 给首页的修法同一套行为（审查总表 R-S8b）。
