## 用户

- 怎么装这个更新：Windows 点「下载更新」，下好后点「重启安装」，弹出授权窗口点「是」，装完会自动打开；Mac 点「重启安装」就行。从这一版起不用再手动点，默认会在你关掉软件或下次打开时自动装上。
- 自动装新版本之前，右下角会先弹一条通知说一声，Windows 上还会提醒授权窗口点「是」，不会再突然关掉、凭空弹出授权窗口。
- 自动装没装上（比如授权窗口点了「否」）时，下次打开会告诉你上次没装上、为什么，只留一颗「重新安装」，不会每次退出、每次打开都再弹一遍授权窗口。
- 更新页、系统通知里的说法和「自动更新」开关对上了：开着时不再写「由你决定、不会自己重启」「可在更新页面重启安装」。更新失败时不再把英文原话直接摆出来，改说是磁盘满了、被安全软件拦了还是安装包坏了，原话记进日志。

## 开发

- 第二十批 6、7。`auto-update-install.ts`：记录新增可选 `quitAttemptedVersion`，`decideQuitInstall` 让退出时自动装每个版本只试一次，之后回到「顺手装上吗」那一问；`decideLaunchInstall` 也跳过退出时试过的版本。`resolvePreviousAutoInstallFailure` 在下次启动时从记录认出「上次自动装过、还是旧版本」，`updater.ts` 新增 runtime 选项 `previousAutoInstallFailure`，下载完成时把该版本停在 `failedStep: 'install'`（code `UPDATE_PREVIOUS_AUTO_INSTALL_FAILED`），只留按钮不再自动装。
- 自动装前的预告：`buildAutoInstallNotice` 出文案，`desktop-notifications.ts` 新增 `announce`（不看通知开关，理由见注释）；退出时发完等 1.2 秒再交给安装器，启动时发完等 5 秒并复核开关、队列和版本再装。
- `updateDesktopNotification` 多收 `autoUpdate`，开着时改说「后台下载 / 关掉软件时自动装上」。更新页导语按开关分两句（`registry/business.ts` 的 `updatesPageLead`），「安装前需要知道」去掉「关闭保护」，重启确认框在 Windows 上提醒授权窗口点「是」。
- `safeError` 认不出的英文原话经 `describeUnrecognizedUpdateFailure` 按磁盘满 / 权限占用 / 文件没了或校验不过 / 其它四类说人话，脱敏原话放进可选的 `error.detail`，随 `update/state.changed` 进 runtime.jsonl；中文原话照旧。安装器没起来那句改成指向「更新」页的「重新安装」。
- 授权窗口是否真的弹出、点「否」之后 electron-updater 的实际表现没在 Windows 真机上演过。
