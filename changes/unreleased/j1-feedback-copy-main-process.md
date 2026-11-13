## 开发

- 反馈与客服页「复制给客服」挪到主进程复制（深查 33 张旧卡核对 J1）：以前页面先等主进程现生成反馈报告（慢的电脑要好几秒），
  再自己 `navigator.clipboard.writeText`；客户这几秒切去微信等着粘，窗口没了焦点，Chromium 拒绝页面写剪贴板，复制失败、
  客服窗口也不开，页顶只出一句通用的「操作没有成功」。现在 `runtime-logs:copy-feedback`（`copyFeedbackReport`）多认一种入参
  `FeedbackMessageCopyRequest`（留言类型三选一、描述、联系方式、身份行、最近一次出错、要不要附报告），主进程按
  `electron/feedback-message.ts` 的固定格式拼好、现生成报告、用 Electron 的 `clipboard` 写入，不看窗口在不在前台。
  入参由 `parseFeedbackMessageCopyRequest` 校验：只认这六个字段、类型只认 `bug`/`idea`/`other`、各段限长、拒 NUL；
  页面给不了报告内容，也给不了这个格式以外的东西，这条通道照旧不读剪贴板。报告生成不出来时照样复制客户写的，回
  `reportMissing: true`，日志里照旧记那一行 `runtime-logs:preview-feedback失败`。`buildFeedbackMessage` 从
  `FeedbackPage.tsx` 搬进 `electron/feedback-message.ts`（进渲染层可值引用名单），界面上的字不变。
