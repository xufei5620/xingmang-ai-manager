## 开发

- 0.2.25 第三轮复查第 1 条：开着手机遥控时关窗选「安装更新并退出」，安装程序没起来（Windows 授权窗口点了「否」、
  Mac 安装器交接失败）时，手机先收到「已退出」，紧跟着又收到「电脑端的星芒未退出，遥控仍保持开启」，可星芒照样退了。
  原因是 `main.ts` 的 `updateQuitHandoff.abort` 不管有没有真撤回退出都调 `codexRemote.quitAborted()`；关窗这条路上退出是客户
  自己选的，`abortUpdateQuit()` 什么也不撤。现在 `abortUpdateQuit()` 返回这次是不是真撤回了，`abort` 只在撤回了时放回画布、
  补那一句。更新页「重启并安装」这类由安装发起的退出照旧补（打磨 B8）。`electron/window-lifecycle.ts`、`electron/main.ts`，
  不加新字，没有新增通道。
