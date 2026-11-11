## 用户

- 聊天空白页的示例多了几句不写代码也用得上的：改写、翻译、写文案、问 Excel 公式。

## 开发

- Fable 第二轮 Y1（产品负责人 2026-11-10 北京回「示例改」）：聊天空白页示例从三句换成六句，拿掉「用大白话解释什么是
  API 密钥」；列表挪进 `chat/state.ts` 的 `chatExamples`，带「……」的半句话填进输入框时由 `chatExampleDraft` 去掉
  末尾省略号、光标停在末尾。点了照旧只填不发。
- Fable 第二轮 Y2（产品负责人 2026-11-11 北京回「改名置顶改」）：对话「…」菜单加「改名」「置顶 / 取消置顶」。`state.ts` 加
  `renameConversation` / `setConversationPinned` / `groupConversationList`（置顶的单独一段，其余照旧按天分）、
  `MAX_CONVERSATION_TITLE_LENGTH`（40）；改名不动 `updatedAt`，自己起的名字记成 `renamed`，消息删光后再发不被第一句话盖掉。
  `pinned` / `renamed` 存在本机聊天记录里，`storage.ts` 读的时候只认 `true`。
