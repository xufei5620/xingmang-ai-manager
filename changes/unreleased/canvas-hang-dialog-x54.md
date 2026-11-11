## 开发

- 画布窗口卡死也弹「界面没有响应」（决定单第六节 X54，崩溃恢复.md KR-2）：`canvas-window.ts` 给画布窗口接上 `unresponsive` / `responsive`，复用主窗口那套 `createWindowResponsivenessGuard`（一窗一个框、恢复了或窗口关了自动收框）。字是主窗口那几句换主语，照决定单逐字：标题「界面没有响应」、正文「无限画布暂时没有响应。」、说明「可以再等一会儿，画布通常会自己恢复。重新加载只会重启画布，正在进行的安装、下载和已保存的设置都不受影响，但画布上还没保存的改动会丢失。」、按钮「继续等待／重新加载」。用户行并进了 `canvas-quit-saves-first.md` 那一条。
- 选「重新加载」先 `forcefullyCrashRenderer()` 结束卡住的进程（Electron 文档给 `unresponsive` 的办法，只换地址的话新页面还得卡住的进程来接），等 `render-process-gone` 来了再按当前深浅色重建入口地址加载，回到画布首页。这一次记 `canvas/process.ended-for-reload`，不记成 `process.gone` 崩溃，也不占自动重载「一分钟两次」的次数。进程跟别的页面共用、或已经没了时不结束进程，只换地址重新加载；判断放在 `window-responsiveness.ts` 新加的 `rendererProcessIsOwn()`（跟 `main.ts` 的 `releaseRendererProcess` 同一套判法）。主窗口那边的同一问题（KR-3）这次不动。
- 不加通道、不碰 `canvas-v2/`；正在等关闭确认的，进程结束时照旧按取消算。
