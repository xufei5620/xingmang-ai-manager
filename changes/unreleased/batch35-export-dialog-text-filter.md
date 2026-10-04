## 用户

- Windows 上导出检查报告、反馈报告时，保存窗口里的「保存类型」不再是英文「Text」，改成「文本文件」，和导出聊天对话时一样。

## 开发

- 第三十五批 C：`electron/ipc.ts` 里 `diagnostics:export`、`runtime-logs:export-feedback` 两个保存窗口的类型名从 `'Text'`
  换成 `chat-history:export-text` 早就在用的 `'文本文件'`。`ipc.test.ts` 新增一条用例，钉住这三个存 .txt 的保存窗口都用这个名字。
