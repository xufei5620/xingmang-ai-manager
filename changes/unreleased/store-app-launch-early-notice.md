## 用户

- 用 Windows 自带的「Administrator」账户登录、或关了「用户账户控制」的电脑，从微软商店装的软件常常打不开。以前要等 Codex 桌面端装完、点「打开」再等将近一分钟才告诉你；现在装之前就说：首页和「安装卸载」页 Codex 桌面端那一行、新手引导里装 Codex 桌面端那一步都会先提醒一句，检查页「运行权限」也改成黄色「需留意」。只是提醒，照样能装。

## 开发

- 「这个账户能不能打开商店应用」的判断从 `codex-desktop-service.ts` 抽到新模块 `electron/windows-store-app-launch.ts`（`resolveStoreAppLaunchBlock`），打开失败后的解释（#658）和装之前的提醒共用这一份。内置 Administrator 开了「管理审批模式」（`FilterAdministratorToken = 1`）时不再算作打不开。
- Codex 桌面端首页那条合并探测脚本顺路读当前账户和那条策略键，未安装时 `DesktopAppStatus.storeAppLaunchBlock` 带上结果，首页不为它另起 PowerShell。
- 检查页 `ADMINISTRATOR` 在令牌本身高权限（`alwaysElevated`）时多问一次（4 秒上限，可经 `inspectStoreAppLaunchContext` 注入），认出来改为 warn，`details.storeAppLaunchBlock` 标明是哪一种；没问出来照旧 pass。
