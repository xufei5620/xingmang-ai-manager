## 用户

- 开机后软件自动安装上次下好的新版本前，窗口角落也会出现一张「马上更新」的提示卡并倒数秒数，关了系统通知或开着专注助手的电脑上也能看到软件为什么要关掉、授权窗口为什么会弹。

## 开发

- 开机自动装前的 5 秒预告不再只靠系统通知（第二十四批 ⑥）：`UpdateSnapshot` 加可选 `launchInstallNotice`（版本、标题、正文、预计开装时刻），`UpdaterService.setLaunchInstallNotice` 写入；`main.ts` 发系统通知的同时写进快照，情况变了或出错时收回。快照离开 `downloaded` 或安装器报错时在 `emit` 里统一清掉。渲染层 `features/app/LaunchInstallNotice.tsx` 经 `StartupNotices` 的 `leading` 插槽放在开机角落，带倒数、不可关。自动装开关与 5 秒时长不变，没加 IPC 通道。
