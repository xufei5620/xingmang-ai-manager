## 用户

- Windows 上开着加速直接卸载软件，卸完电脑也能照常上网了。以前卸载时加速被一起关掉，电脑的上网设置还停在加速那一份上，浏览器、微信都连不上，得重装软件打开一次才好。现在卸载前会先把上网设置改回开加速之前的样子；你自己后来改过的设置不会动。
- 卸载时顺手删掉「开机自动启动」那一条，卸完不会每次开机报找不到程序。

## 开发

- 「可能没想到的问题」第 9 条。`build/installer.nsh` 新增 `customUnInstall`：electron-builder 的 `CHECK_APP_RUNNING` 把安装目录下的进程（桌面进程和加速辅助进程）强行结束之后、`customRemoveFiles` 删文件之前，用 `ExecWait` 以 `--xingmang-uninstall-cleanup` 再拉起一次安装目录里的 exe 并等它结束。升级安装会带 `--updated` 跑旧版卸载程序，那时不做（否则每次升级都会把用户的开机启动关掉）。失败只进卸载详情，不拦卸载。
- 新分支 `electron/uninstall-cleanup-entry.ts`（零依赖，`platform/entry.ts` 最先判断）与 `electron/uninstall-cleanup.ts`：`ready` 之前完成，不抢单实例锁、不开窗口。代理还原直接调 `createWindowsSystemProxy({ journalPath }).recover()`，与辅助进程崩溃后重放恢复记录是同一段比较后写入：系统代理仍等于加速写进去的那一份才还原，改过的一律不碰，只交还租约。没有恢复记录（从没开过加速）就不起 PowerShell。开机项走 `platform/system-service.ts` 新增的 `removeWindowsLoginItem`，与 #355 同一写法，按名字删，带参数与 0.2.9 前不带参数的两种都能删掉；名字取 `login-launch.ts` 新增的 `windowsAppUserModelId`（`main.ts` 改用同一个常量，scripts 测试钉住它等于 electron-builder 的 `appId`）。非打包环境不执行，免得开发机误删已安装版的开机项。退出码按位：1 代理未还原、2 开机项仍在、4 超时（150 秒；卸载时 PowerShell 常是冷启动，单次命令上限从辅助进程用的 15 秒放宽到 45 秒，`createWindowsSystemProxy` 新增可选 `commandTimeoutMs`，缺省不变）、8 不支持。
- 恢复记录路径收口到 `acceleration-development-host.ts` 的 `accelerationProxyJournalPath`，辅助进程与卸载清理共用。
- 新工作流 `.github/workflows/windows-uninstall-smoke.yml`（不进必需门禁，只在改到这条路径时跑）：Windows runner 上打一份不签名安装包，静默安装，摆出「系统代理指向已死端口 + 恢复记录 + 开机项」，静默卸载，检查代理回到原值、记录与开机项都没了（`scripts/windows-uninstall-cleanup-smoke.ps1`）。
- 已知边界：卸载程序以管理员运行。若提权时输入的是另一个管理员账号（标准用户卸载），清理读写的是那个账号的注册表和数据目录，本用户的代理不会被还原，不会误改。macOS 是拖进废纸篓卸载，没有可挂的钩子。本次不加「同时删除登录记录」勾选框，等 yoyo 定。
