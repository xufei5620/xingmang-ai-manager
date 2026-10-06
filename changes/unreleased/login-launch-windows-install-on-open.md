## 用户

- Windows：设了开机自动启动、开机后一直没点开窗口的，上次下好的新版本以前要等退出星芒才装；现在第一次打开星芒窗口时，会像平常打开时一样先提示「星芒AI马上更新」，几秒后自动装上（会弹出授权窗口），装好自己打开。那时正开着加速的，照旧留到退出星芒时再装。

## 开发

- Windows 开机自启、窗口没打开过时，打开时装不再直接留到退出时（#840 的 'skip'）：`resolveLaunchInstallMode`
  新加 'window'，记下这一版，主窗口第一次 `show` 时照 'notice' 那样先预告、等 5 秒再装（UAC 照弹）。只
  Windows（安装包 perMachine，每次装都要授权，开机自启、只关机不退出的人留到退出时就一直装不上）；Mac 不变。
- 等到第一次打开窗口才装的，离开机可能已经过了几个小时：预告之前和等完各用 `shouldStillInstallAtLaunch`
  看一眼（入参 `background` 换成 `mode`），这时开着加速就不装，留到退出时（装的时候加速会断，装好不会自己
  连回去）。日志：等窗口时 `install.on-launch.held` 写明等第一次打开窗口，打开窗口去装时
  `install.on-launch.window-shown`，不装时 `install.on-launch.skipped`。`main.ts` 里三种装法共用一个
  `startLaunchInstall`。
