## 用户

- 界面长时间没反应时会弹出提示，可以选「继续等待」或「重新加载」，不用再去任务管理器强杀程序；
  重新加载只重启界面，正在进行的安装、下载和已保存的设置都不受影响，界面自己恢复时提示会自动消失。

## 开发

- 新增 `electron/window-responsiveness.ts`：把主窗口 `unresponsive` / `responsive` 的配对处理抽成注入式
  `createWindowResponsivenessGuard`，同一窗口同一时间只允许一个对话框，`responsive` 到达时用 `AbortSignal`
  关掉还开着的对话框且不触发重载，窗口销毁后也不再重载。`electron/main.ts` 的 `unresponsive` 处理由只记一条
  warn 改为额外弹出系统对话框（父窗口为主窗口，默认「继续等待」），选「重新加载」调 `webContents.reload()`；
  对话框弹出与用户选择各写一条 `runtime.jsonl`。单测见 `electron/window-responsiveness.test.ts`。
