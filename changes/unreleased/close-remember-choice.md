## 用户

- 点右上角关闭时弹出的询问框多了一个「记住我的选择」，勾上后以后点关闭就不再问，想改回来去「设置 → 启动与关闭」。默认还是每次询问。
- 第一次缩到托盘时会提醒一句窗口去哪了（Windows 在右下角托盘，看不到就点任务栏右边的小箭头；Mac 在屏幕顶部菜单栏），只提醒这一次。

## 开发

- 关闭询问框加 `checkboxLabel`，`requestCloseDecision` 可返回 `{ decision, remember }`；勾选且不是「返回」时经新钩子 `rememberCloseBehavior` 写 `closeBehavior`，退出前等它写完（`window-lifecycle.ts`、`main.ts`）。
- 新钩子 `onHiddenToTray`：第一次缩到托盘发主进程通知 `hiddenToTray` / `hiddenToMenuBar`（不归哪一类通知偏好，只看总开关）；系统通知发不出时 Windows 退到托盘气泡（`application-tray.ts` 的 `showBalloon`）。提示出过后 `settings.json` 记 `trayHintShown: true`，只落 true，渲染层保存设置的通道带不进来。
- 设置页回到窗口时重读 `closeBehavior`，避免停在设置页时关窗记住选择后，那一行还显示「每次询问」、点了没反应。
