## 开发

- 深查 D42（聊天页 C6，产品负责人 2026-11-11 回「决定单照推荐」，字照决定单原样）：聊天输入框和「编辑消息」框去掉
  `maxLength`（原先是 40000，带文件以后是 `draftTextRoom` 扣掉文件后的余量），贴进超长的字不再被浏览器悄悄截掉尾巴。
  `chat/state.ts` 新增 `draftLengthError`，跟 `planTurn` 同一个口径（去掉首尾空白、用 `messageWithFiles` 连同带的文件一起算）
  超过 `chatLimits.messageLength` 时给出「最多 40000 字，现在 N 字，删掉一些再发。」：输入框下面显示这一句、发送按钮和
  Enter 都不发；编辑框用 `Textarea` 的 `error` 显示在框下面，「修改并重发」灰掉。`draftTextRoom` 没有别处用，删掉。
  「## 用户」并进 `chat-limit-200.md` 那一条（这一版更新页已经 60 条到顶）。
- 参数设置里的「系统提示词」照旧 `maxLength={40000}`：那一格没有发送按钮，决定单没给它的字，这次不动。
