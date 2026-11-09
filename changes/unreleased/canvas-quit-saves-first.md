## 用户

- 开着画布退出软件时，画布先把最后的改动存好再关；还有在生成的，会先问一句：返回画布、停止本地任务并保存，或者等生成完再关。画布卡住没反应的，等几秒就直接关掉，不会拦着软件退不出去。

## 开发

- 退出前先走画布自己的关窗流程（#1368 第 9 条）：`window-lifecycle.ts` 加可选的 `closeCanvas`，排在 `confirmQuit` 前面，主进程接到 `canvasController.requestCloseForQuit()`（见下一条）。画布那边是现成的关窗确认（内核 `persistence/canvas-close.ts`）：没在生成的直接存一次再关，在生成的弹它现有的确认框，不加新字、不加新通道。用户回了画布，这次退出作废，主窗口不拉出来；画布收尾出错照常退出。Windows 关机、Mac 关机时不等画布。缩到托盘不碰画布。
- `requestCloseForQuit()` 先用 `executeJavaScript('1')` 看画布页面还回不回话，4 秒没回（卡死但没崩，`render-process-gone` 不会来）就直接销毁画布、照常退出，日志记 `canvas/close.unresponsive`；回了话（包括回了个错）才走关窗确认，正弹着「还有进行中的任务」的框就一直等用户点。没有这一步的话，卡死的画布会让退出白等 60 秒再作废。
