## 开发

- 0.2.24 深查改字批次 X01（D11，自身更新.md Z-7，产品负责人 2026-11-10 北京回「按照你的推荐做」）：发布者撤回本机这一版、
  退回旧版时，主窗口外这几处不再说「新版」，跟设置页「建议退回」一个口径；平时（升级）一字不变。
- 退出时自动装的系统通知：标题「正在安装星芒AI新版本」改「正在换回星芒AI的 X 版」，正文「正在装新版 X，装好会自动打开。」
  改「正在换回 X 版，装好会自动打开。」（`auto-update-install.ts` 的 `buildAutoInstallNotice`，`moment: 'quit'`）。
- 打开时自动装的预告（系统通知和窗口里那张卡同一句）：「上次下好的新版 X 几秒后开始安装……」改「上次下好的 X 版几秒后开始安装……」，
  后半句和标题「星芒AI马上更新」不动（`moment: 'launch'`）。
- 退出时那一问：「新版本 X 已经下载好，顺手装上吗？／现在装上吗？」改「建议退回的 X 版已经下好，顺手装上吗？／现在装上吗？」
  （`quitInstallPrompt`，Linux 系统安装器那条是「现在装上吗」）；跳框「新版 X 已经下好，现在装上吗？」改「建议退回的 X 版已经下好，
  现在装上吗？」（`update-install-prompt.ts` 的 `buildInstallPrompt`）。说不出版本号时照旧。
- 判断来自快照里已有的 `rollback`（`updater.ts` 按「下好的版本比本机旧」算）：`quit-blocking-tasks.ts` 的 `InstallableUpdateOnQuit`
  多带一个 `rollback`，退出那条直接用；打开时预告、跳框要先等几秒，用新的 `isRollbackInstall(snapshot, version)`，只有快照里下好的还是
  这一版时才换说法，对不上按平时说。三个文案函数的新参数都是可选的，缺省 = 旧行为。
- 单子没列的几句没动：`desktop-notifications.ts` 里「新版 X 已经下好／正在后台下载」那几条系统通知。
- 接着补齐剩下三处（Fable 复查第二节第 6 条，产品负责人 2026-11-11 北京回「退回旧版改」）；除第一处平时也跟着改外，平时（升级）一字不变：
  一、退出那一问的小字「安装很快，装完会自动打开新版本。」去掉「新版本」，平时和退回同一句（`quitInstallPrompt`）。
- 二、上次自动装没装上那句（更新页、首页气泡）：退回时开头「新版本上次没装上」改「建议退回的 X 版上次没装上」，后半句不动
  （`previousAutoInstallFailureMessage` 多一个可选的 `rollbackVersion`；`updater.ts` 的 `previousAutoInstallFailure` 回调多传一个
  `rollback`，跟快照里 `rollback` 同一个算法，`bootstrap/updates.ts` 拿它决定传不传版本号）。
- 三、托盘「版本更新」那一项：`TrayUpdateEntry` 带上快照的 `rollback`，退回时六种写法换成「建议退回 X 版」「建议退回的 X 版等电脑腾出空间再下载」
  「正在下载建议退回的 X 版」「重启并退回 X 版」（Linux「退回 X 版」）「建议退回的 X 版已下载好」「退回 X 版没成功，点开看看」
  （`application-tray.ts`）。读不到版本号时照旧用平时那几句；点下去走的动作不变。
