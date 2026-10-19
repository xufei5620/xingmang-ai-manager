## 用户

- Mac 上画布或付款窗口在最前面时，从菜单栏选「设置...」或按 ⌘, 也能打开设置页了；主窗口收起来时，会先把它叫出来再跳到设置页。

## 开发

- #1210：`electron/main.ts` 的 Mac 应用菜单「设置...」不再发给 `BrowserWindow.getFocusedWindow()`（画布、付款窗口在前时发进它们，没人接），
  改为先 `showMainWindow()` 再 `sendToMainWindow('onNavigate', …)`，跟托盘跳页同一个写法。菜单仍在建主窗口之前设上，回调经
  `navigateFromAppMenu` 晚绑定，主窗口建好之前点了不做事。`electron/main.test.ts` 读源码钉住菜单回调和这次赋值。
