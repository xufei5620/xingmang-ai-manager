## 用户

- 桌面通知现在默认打开，可以在设置 → 通知里关掉。

## 开发

- `AppSettings.desktopNotifications` 改为缺省 = 开启，只落盘显式的 `false`（同 `crashReporting`）；主进程通知控制器、平台通知读取与 renderer-v2 设置页都按 `!== false` 判断。旧版本从不写 `false`，所以以前手动关过的用户升级后会被打开一次。legacy 回滚界面已冻结，未跟改。
