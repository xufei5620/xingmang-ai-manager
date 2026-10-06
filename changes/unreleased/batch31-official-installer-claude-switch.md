## 用户

- 用 Claude Code 官方安装器装的 Claude Code，首页现在也能点「更新」了：点了先问一句，同意后星芒先把官方那份卸掉，
  再装上新版本，工具配置、账户数据和历史记录都会保留，以后在星芒里点一下就能更新。新手引导里的「更新」、
  「安装与卸载」页的「重新安装」也一样。磁盘空间不够装回来时，星芒不会先卸。

## 开发

- 第三十一批 B（yoyo 2026-10-04 点头）：官方安装器（`installSource: 'native'`）装的 Claude Code 以前首页只给一句
  「用它原来的方式更新」，可 `config-files.ts` 写的 `DISABLE_AUTOUPDATER` 不看安装方式，连它的自更新也关了，客户就停在
  旧版本上。新增 `canSwitchToManagedInstall`（Claude、native、`uninstall.available`）与 `updatesOutsideApp`，后者替换
  首页、安装卸载页、新版本通知里原来看 `isExternallyManagedInstall` 的地方，能换的这一种照给「更新」「更新到推荐版本」；
  `toolUpdateOffer().manualHint` 对它变成 null，新手引导的「更新」按钮和结果页「建议更新到 X」那句跟着一起变。其他来源的
  Claude / Gemini、官方安装器装的 Codex 不变。
- `App.tsx` 的 `install()`：先过原有的断网、运行环境检查，再弹 `managed-switch-confirm`（三句话在 `managed-switch.ts`，
  照点过头的原话），客户同意后在同一个安装任务里依次准备运行环境、卸载、安装，卸完到装上的空档最短，运行环境要重启电脑时
  官方那份也还在。版本由 `managedSwitchVersion` 定下（点名的 → 钉住的推荐版本 → 最新版 → 推荐版本），确认框写哪一版就点名
  装哪一版。点「取消」或关框返回新的 `ToolInstallOutcome` `'declined'`，什么都不动，安装卸载页也不出提示。这一份已经在换
  （任务还在跑）时再点不重复问，按已在装处理。真动手卸之前再看一眼网（`offlineNow`，确认框可能开了好一阵），断了就先不卸。
  卸载这一步不能取消（现成的「这一步已经不能取消了。」），安装那一步照旧走取消通道；卸载留下被占用的旧版本文件
  （`manual-required`）时照常装上并弹原有的清理说明；卸载转交给普通窗口时和「卸载」一样刷新一次；卸载后安装失败或被取消时
  刷新一次，这一行回到「安装」。
- IPC `cli:uninstall` 加可选第二个参数 `CliUninstallOptions`（`{ reinstall?: boolean }`），`ipc-contract.ts`、`preload.ts`、
  `ipc.ts` 三处一致，没加新通道、注册顺序不变；`parseCliUninstallOptions` 只认 undefined 或只带布尔 `reinstall` 的对象，
  别的形状报「卸载参数格式错误」。带 `reinstall` 时 `system-service.ts` 的 `uninstallCliOperation` 动手前先跑
  `assertInstallDiskSpace`（和安装同一句、同一个门槛），盘不够就一个文件都不删。
- 文档：`docs/CLI-NATIVE-INSTALLS.md` 的识别口径补上这个例外；`docs/CLI-VERIFIED-VERSIONS.md` 记下 `DISABLE_AUTOUPDATER`
  对官方安装器那份生效这一条已在沙箱用真二进制演过（Windows / Mac 真机没演过）。
