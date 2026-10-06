## 用户

- Windows：用系统自带的 Administrator 账户（或者关了「用户账户控制」、右键「以管理员身份运行」星芒）时，装 Node.js、Codex 桌面端之前不再说「Windows 会弹一次授权窗口」，点「重启安装」和自动装更新前的提示也不再叫你点授权窗口里的「是」。这种电脑上本来就不弹。

## 开发

- 已知19：`resolveWindowsCliExecutionModeDetailed` 多回一个 `highIntegrity`（读出了完整性标签才有；自带 Administrator
  的默认令牌也是 High，照旧 same-user），启动日志 `cli.execution-mode` 跟着记。`main.ts` 把它作为
  `windowsProcessElevated` 交给 `registerIpcHandlers`，`platform:get-capabilities` 为真时叠上 `processElevated: true`
  （`PlatformCapabilities` 新可选字段，缺省 = 旧行为）。`elevation-notice.ts` 三个函数多收一个可选的 `elevated`，为真时
  不出那句：首页运行环境卡和 Codex 桌面端那行、「安装卸载」页 Node.js 和 Codex 桌面端两行；更新页重启安装确认框的
  授权窗口那句、`buildAutoInstallNotice`（打开时装、退出时装的预告）里「Windows 弹出授权窗口时请点「是」。」同样不出，
  后者和 Mac 那份说法一样。没有新字。
