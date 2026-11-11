## 开发

- Fable 第二轮 Q2 第 1 步：新通道 `chat:pick-text-files`（契约、preload、注册、`ipc-channel-policy.ts` 四处一起加，
  成功不记日志）。主进程开系统选文件框、按扩展名只认文字类文件，`bounded-file.ts` 新加的 `readBoundedFilePrefix`
  按 `readBoundedFile` 同一套检查（单链接普通文件、不经过链接、读前读后快照一致）只读开头 256 KB，
  `ai-chat-text-files.ts` 解码（UTF-8 / 带 BOM 的 UTF-16 / GB18030，带 NUL 的当成不是文字）、按 3 万字的额度
  先保全短文件再均分给长文件，有一个读不出来整批不加。渲染层只拿到文件名、大小和字，拿不到路径（I15 同一思路）。
- 渲染层：`state.ts` 的 `messageWithFiles` 把文件用 `<file name="…">` 标记拼在这条消息前面发出去，
  前文、提醒和上限都按拼好的算；输入框的字数上限减去文件占的（`draftTextRoom`），选文件前先算还能放多少
  （`draftFileRoom`）。生成图片时带不了文件，按钮不出、留着的文件卡片下面说明并灰掉发送。文件存进本机聊天记录时
  名字和内容照样打码，导出对话只写「附件：文件名」。PDF、Word、Excel 要加解析库，放第 2 步。
