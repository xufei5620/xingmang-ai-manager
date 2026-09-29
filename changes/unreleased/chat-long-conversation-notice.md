## 用户

- 聊天的一段对话快到上限时，输入框上方会提醒一次：对话越长，每次回复一般花得越多、也越慢，可以点「新对话」接着聊，刚写的话会一起带过去；点「知道了」这段对话就不再提醒。
- 对话到上限发不出去时，提示后面多了一个「带着这句话开新对话」按钮：新对话的模型和设置跟原来一样，刚写的话已经填在输入框里，看一眼再发。

## 开发

- `renderer-v2/features/chat/state.ts`：发出去的前文抽成 `contextMessages`，上限拦截和新加的 `conversationContextShare` / `shouldShowLengthNotice`（条数或字数到上限七成、仅文本模式、未点过「知道了」）共用同一口径；两句上限报错改成常量并由 `isConversationTooLongMessage` 识别；`continueInNewConversation` 按原设置新开对话并搬走草稿。`Conversation` 新增可选字段 `lengthNoticeDismissed`，`storage.ts` 读写时保留。`useChatController` 记住被拦下的那句话（编辑重发时取编辑框里的内容），新增 `continueInNew` / `dismissLengthNotice`。第十六批第 9 条。
