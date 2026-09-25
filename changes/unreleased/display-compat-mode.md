## 用户

- 显卡驱动不稳的电脑也能打开：界面在短时间里接连出问题后，下次打开会自动换成更稳的兼容方式显示，并问你以后一直这样还是恢复原来的方式。设置页「外观」里也多了「用显卡加速显示」开关，遇到黑屏、花屏、闪烁或打开就闪退时可以自己关掉，重开软件后生效。

## 开发

- 新增 `electron/display-compat.ts`：主进程监听 `child-process-gone`，显卡进程非正常退出时同步追加一行时间戳到 `%APPDATA%\xingmang-ai-manager\display-crashes.log`（同步 + fsync，防止 Chromium 连崩后直接结束进程时记录没落盘）。下次启动在 ready 之前读它，10 分钟内 2 次以上就调 `app.disableHardwareAcceleration()`，并经 `WindowCapabilities.displayCompat` 让渲染层挂一条二选一提示。
- 设置加 `hardwareAcceleration`（缺省开，只落盘 `false`，同 `crashReporting`）；设置保存时带了这个字段就清掉崩溃记录、从头再数。新 IPC 通道 `window:relaunch`（「现在重开」，走正常退出流程，退出确认里点返回会撤销重开；退出时装更新则不重开，由安装器打开新版本）。`safe-local-data.ts` 补 `removeSafeDataFileSync`。缺省行为不变：没出过问题的电脑照旧用显卡加速。
