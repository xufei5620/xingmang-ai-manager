## 用户

- 聊天回复里的每段代码和命令右上角多了一个「复制」按钮，只复制这一段，贴进终端不会带上前后的说明文字。

## 开发

- `src/renderer-v2/features/chat/ChatPage.tsx`：给 `ReactMarkdown` 加 `pre` 渲染，代码块右上角放复制按钮（行内代码不加）；成功时按钮变「已复制」2 秒并走底部提示条，失败时照旧弹「手动复制内容」。Markdown 渲染表改用 `useMemo` 固定，避免每次重渲染把代码块重新挂载、丢掉「已复制」状态。浏览器用例在 `features/chat/browser-check.mjs`（第十四批候选 10）。
