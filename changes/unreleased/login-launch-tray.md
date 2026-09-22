## 用户

- 勾了「开机自动启动」后，开机时软件只在托盘里待命，不再把窗口弹到桌面正中间；要用时点一下托盘图标就行。自己双击图标打开时照常弹出窗口。之前就勾过的也自动生效，不用重新设置。

## 开发

- 第十批候选 4。新模块 `electron/login-launch.ts`：Windows 开机项带 `--launched-at-login` 参数，macOS 13 起登录项走 SMAppService 不能带参数，改读 `getLoginItemSettings().wasOpenedAtLogin`；读失败按普通启动处理。`shouldRevealInitialWindow` 只有「开机启动且托盘可用」才不弹首个窗口，托盘建不起来照旧弹（`application-tray.ts` 托盘中途失效时也会走 `onOpen` 兜底）。
- `main.ts` 的 `ready-to-show` 不弹时把最大化延到第一次 `show`（对隐藏窗口调 `maximize()` 会直接把它显示出来），并记一条 `window/launch.login-hidden` 便于排查「怎么没窗口」；`second-instance` 带着这个参数时不抢焦点。
- Windows 开机项按「路径 + 参数」整条比对：`platform/system-service.ts` 查询时把旧版不带参数的那条也认成已开启；新增 `migrateLegacyWindowsLoginItem` 在 `setAppUserModelId` 之后同名覆盖成带参数的一条，保留任务管理器里的禁用状态（`enabled` 取旧条目的 `executableWillLaunchAtLogin`），结果记 `main/login-item.migrated` 或 `login-item.migrate.failed`。
- 设置页「开机自动启动」的说明改成「开机后在托盘里待命，不弹窗口」。
