## 开发

- 聊天框粘贴在资源管理器、访达、文件管理器里「复制」的图片文件不再没反应（0.2.24 深查剪贴板拖放 J4；用户可见的那句并进
  `fable2-chat.md`）。原来 `ChatPage.tsx` 看见剪贴板里有图片文件就拦下交给主进程，主进程只认 `image/png` 位图，复制的
  文件只有路径没有位图，`chat:paste-image` 回 `null`，页面收到空的直接返回。现在 `clipboard-image.ts` 的
  `readClipboardFilePaths` 先读 Electron 列出的 `text/uri-list`（沙箱里 Electron 45.1.0 实测，Linux 文件管理器复制的文件就是这样
  列出来的），再按平台兜底读 Windows 的 `FileNameW`、Mac 的 `public.file-url`（这两种没在真机上演过）；读出的路径交给
  `ai-chat-attachments.ts` 跟选文件框同一段 `storeFiles`：同样的张数上限、`readLocalFile` 的有界读取和 reparse / 硬链接检查、
  20 MB 原图上限、`prepareChatImage` 认格式和缩图，一张不行整批不存。剪贴板里位图和文件都有时照旧用位图，以前能贴的
  一张都不变。`chat:paste-image` 改成带 `remaining`、回 `AiChatAsset[]`，跟 `chat:pick-images` 一样；不加新通道，
  路径仍只在主进程里从系统剪贴板读，渲染层给不出路径。Mac 访达复制文件推测会带文件名文字，按 J3 的规则当文字贴出，
  这次不动。
