## 用户

- 修好 Mac 上「设置 → 通知」里各项通知只显示「此版本暂不支持」、开关点不了的问题；余额不足、新公告、工具有新版本这类桌面通知在 Mac 上也会正常弹出了。

## 开发

- `electron/platform/install-system-api.ts`：macOS 的 NativeWindowMac 在 `browser-window-created` 之后才写入构造参数里的标题，按标题认主窗口在 Mac 上永远落空，系统设置桥（`window.xingmangPlatform`）的预加载从未注册。改为在构造返回后的微任务里认窗口（此时页面尚未加载，标题无法被页面改写）。
- Mac CI 新增 `e2e/renderer-v2-native.mjs` 一步，桥缺失时打印窗口、预加载与主进程输出的现场。
