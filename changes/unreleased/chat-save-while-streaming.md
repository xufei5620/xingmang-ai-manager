## 开发

- 聊天页出字时也存盘（0.2.24 深查聊天页 C1）。`useChatController.ts` 的自动保存原来是「停下 250 毫秒才存」，主进程每 50 毫秒推一段字，计时一直被重置，整段说完之前一次都不存；现在从头一处没存的改动算起最多等 2 秒（`storage.ts` 的 `autosaveDelay`）。
- 退出前先让聊天页交出手上的那一份：主进程 `prepareToQuit` 先经 `chat-history-flush.ts` 发 `chat-history:flush-requested`，界面（App 上的 `answerHistoryFlushRequests`，聊天页开没开都回）把开着的聊天页存一次、等写完，回 `chat-history:flushed`，主进程再等 `chatHistoryStore.idle()`。新加这一对主窗口通道，只带一个随机编号；界面这一页没报告过手上有没有事（重新加载中、托盘省内存关掉、崩了、旧回滚界面）就不问，问了不回等满 1.5 秒照样退，不拦退出。不加新字，退出前「正在回复，要不要退」那一问没做（要加字）。
