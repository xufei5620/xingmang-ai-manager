## 开发

- 聊天回复途中断网，在那条下面说一句（0.2.24 深查聊天页 C14，汇总决定单 D43，批次 X14；产品负责人 2026-11-11 北京回「决定单照推荐」，字照决定单原文）。
  主进程 `ai-chat-service.ts` 要连着 3 分钟收不到一个字节才停（`idleTimeoutMs`，给长思考模型留的，Q43），这期间界面只转「正在生成」。
  现在 `chat/state.ts` 加 `offlineReplyNotice`「网络断了，这条回复可能接不上，可以先停止。」和 `shouldShowOfflineReplyNotice`：还在等字或出字的回复、且 `useOnlineStatus()` 说断网时，`ChatPage.tsx` 在那条下面挂一行（`chat-message-note`，`data-testid="chat-message-offline"`）。
  网回来就收起；不替用户停、不改 3 分钟时限、不加按钮（停止按钮本来就在输入框右边）。出图那条不挂：停下也可能照样计费，停之前另有一问。
- 用户行并进 `offline-unsent-ai-request.md` 那条「对话回复到一半网断了」的末尾（更新页「## 用户」已经 60 条到顶）。
