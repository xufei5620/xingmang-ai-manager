## 用户

- 聊天里对话很长时，在输入框打字不再一顿一顿的。

## 开发

- AI 聊天的消息行抽成 `React.memo` 的 `ChatMessageItem`（`src/renderer-v2/features/chat/ChatPage.tsx`），行内操作走一个稳定的转发对象，输入框每按一键不再重新解析全部消息的 Markdown。实测 200 条消息的对话：每键重解析 200 段 → 0 段，一次按键同步耗时中位数约 330 ms → 约 15 ms（容器里开发版 React，只看相对变化）。`browser-check.mjs` 加了按渲染次数断言的回归用例。
