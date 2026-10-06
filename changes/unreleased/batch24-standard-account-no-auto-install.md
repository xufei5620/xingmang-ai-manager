## 用户

- Windows：电脑登录的账号不是管理员的（比如公司、学校配的电脑，家里长辈用的子账号），星芒不再自动装新版本。以前每出一版，软件都会自己关掉、再弹一个要管理员密码的窗口。现在新版本照旧在后台下好，下好后提示「这台电脑的账号不是管理员，装更新时要输入管理员密码。让有管理员账号的人点一次「重启安装」，或者找客服。」；更新页、「自动更新」开关的说明、点「重启安装」后的确认框和必须更新的那一页，也都改说要输入管理员密码。管理员账号的电脑不变。

## 开发

- 第二十四批 2：Windows 安装包是 perMachine，装更新一定弹 UAC；账号不在 Administrators 组时 UAC 要别人的
  管理员密码，打开时装、第一次打开窗口时装（#881）、退出时装都只会把软件关掉、再弹一个填不了的窗口。`main.ts`
  启动时用 `inspectWindowsElevationCapability`（whoami /groups，3 秒上限）问一次，问出 'standard' 时：
  `decideLaunchInstall` 新入参 `standardAccount` 返回 null；`decideQuitInstall` 在自动更新开着时返回新值 'leave'，
  不装也不弹「顺手装上吗」，直接退出（日志 `quit.update-left`），自动更新关着时照旧问。问出来之前打开时装先不定，
  问出来后用 `considerLaunchInstall` 再看一遍；退出时最多等这一次问完，'standard' 时也不再等撤回名单。问不出来
  （'unknown'）照旧自动装（Windows 上记一条 `install.account-unknown`）。
- 更新快照加可选的 `installNeedsAdminPassword`（`updater.setInstallNeedsAdminPassword`，只在问出 'standard' 时出现，
  Windows 管理员账号和 Mac、Linux 的快照不变）。渲染层据此换字：首页气泡和更新页（下好时，`standardAccountUpdateNotice`）、
  系统通知（下好时换键 `<版本>:downloaded:admin-password`，问出来之前已经弹过的那条会被收掉；正在下载时）、更新页顶上、
  「自动更新」开关说明（更新页和设置页）、重启安装确认框、强制更新门。文字是 yoyo 2026-10-06 批的原话；主进程和
  渲染层各有一份下好时那句，两边测试都钉住原句。
