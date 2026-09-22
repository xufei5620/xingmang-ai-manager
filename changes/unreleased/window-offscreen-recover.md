## 用户

- 把窗口拖到外接显示器上、再拔掉显示器以后，从托盘、桌面图标或通知把软件叫出来，窗口会自动回到笔记本屏幕正中间，不会再出现「任务栏上有、屏幕上看不见」的情况。正开着的时候拔线也一样会挪回来。

## 开发

- 第十批候选 5。`window-preferences.ts` 新增 `isWindowTitleReachable` 与 `resolveRecoveredWindowBounds`：窗口顶部 36 像素那条标题带在任何一块屏幕的工作区里露出至少 100×20 才算够得着；够不着就按还原尺寸挪回主屏居中。用户自己拖到屏幕边上、标题栏还抓得住的不动。
- 新模块 `window-recovery.ts` 的 `recoverOffscreenWindow` 负责调 Electron：最大化的窗口先还原、挪位置、再最大化，全屏与最小化的不动（还原时的 `restore` 事件会再看一次）。
- `main.ts` 在主窗口的 `show` / `restore` 事件上挂校验，托盘、第二个实例、通知、任务栏还原等所有入口都会经过；另监听 `screen` 的 `display-removed` / `display-metrics-changed`，防抖 500 毫秒后把正显示着的窗口（含画布、充值窗口）挪回来。挪过一次记 `window/window.recovered-offscreen`。
