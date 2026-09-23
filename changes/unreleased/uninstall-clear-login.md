## 用户

- Windows 卸载界面第一页多了一个「同时清除登录记录」勾选框，默认不勾，跟以前一样卸载后保留登录，重装回来还是登录状态。在公用电脑、要转给别人的电脑上卸载时可以勾上，卸完这台电脑上就不留你的登录、保存的账号和记住的密码；本机的 Key 和各工具的设置不受影响。
- Mac 上 Codex 没法自动卸载、要你自己运行一条命令时，提示改成「请在终端中运行」，以前误写成了 PowerShell。

## 开发

- 「可能没想到的问题」第 9 条剩下的部分（勾选框）与第 13 条后半（npm.cmd），外加第 11 条尾巴（下载页写明系统要求）。
- `build/installer.nsh`：新增 `customUnWelcomePage`，照旧插入 `MUI_UNPAGE_WELCOME`，只挂 SHOW / LEAVE 两个回调，在欢迎页正文下方（120u 178u）加 nsDialogs 勾选框，离开时记进 `$xingmangClearLogin`。新增 `customUnInit`：静默卸载没有页面，命令行带 `--xingmang-clear-login` 等于勾上（客服远程与 CI 冒烟用）。`un.xingmangUninstallCleanup` 只在该变量为 "1" 时给程序多带同名参数。两个变量只在 `BUILD_UNINSTALLER` 下声明（-WX 下未引用即报错）。沙箱里用 electron-builder 自带的 Linux makensis 带 -WX 编过卸载程序那一遍（3 页），安装程序那一遍要 wine，交给 windows-uninstall-smoke。
- `electron/uninstall-cleanup.ts`：新增 `loginRecordFiles` / `clearLoginRecords`，删 `account-session.dat`、`saved-accounts.dat`、`realm-accounts-v2.dat`（连同读不出时留下的 `.unreadable-*.bak`）、两个站点各自的 `account-credentials.dat`，逐个走 `removeSafeDataFile`（I8：路径上有链接、文件多链接一律拒绝，但不影响其余文件）。托管 CLI Key 缓存、聊天 Key 缓存、设置不动（与「退出登录保留本机 Key」一致）。排在删开机项之后、还原代理之前；删不干净记退出码第 16 位。单测钉住文件名与 `main.ts` / `realm-account-vault-file.ts` / `realm-data-roots.ts` 的写法一致。
- `scripts/windows-uninstall-cleanup-smoke.ps1`：摆出登录记录后，直接调用清理程序（带与不带新参数）、静默卸载（不带参数应保留）、重装后带参数静默卸载（应删除），每一步都检查 Key 缓存与设置仍在。
- `electron/tool-installation.ts`：提权时委派给普通权限窗口的卸载命令在 Windows 上写 `npm.cmd`（窗口里会把这一行回显给用户，用户照抄进 PowerShell 时不会撞上 npm.ps1 与默认执行策略；cmd.exe 里两种都能跑）。`electron/system-service.ts` 的手动卸载提示按平台写「普通 PowerShell」或「终端」：核对后这条路径上真正带命令的只有 macOS standalone Codex（一段 sh），Windows 上不可自动卸载时本来就不给命令，所以清单说的「叫用户在 PowerShell 里跑 npm」在当前代码里实际只剩委派窗口这一处。`用户端出问题测试命令.txt` 里的 `npm --version` 同理改为 `npm.cmd`。
- `dl-landing/app.js`：Windows 下载项补「需要 Windows 10 或更新的系统」。仓库里只改源文件，dl.solov.cc 上的页面要另行更新。
- 卸载清理还原代理的单次 PowerShell 时限从 45 秒放宽到 90 秒、总上限从 150 秒放宽到 300 秒：windows-uninstall-smoke 在 runner 上第一条冷启动命令就超过了 45 秒（#370 合并前那次整段 55 秒通过，余量本就不多）。慢机器上超时的后果是卸完断网，比多等一会儿重。冒烟步骤时限相应从 10 分钟放到 20 分钟。
