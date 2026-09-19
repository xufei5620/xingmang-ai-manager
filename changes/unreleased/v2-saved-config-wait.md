## 开发

- renderer-v2 浏览器回归不再拿会自毁的 toast 当保存完成的同步点：`app-check.mjs` 在每个页面
  装一个 MutationObserver 记录所有 toast，`waitForSavedConfiguration` 与「配置保存成功」的
  否定断言改读这份记录。toast 出现 2400ms 后自删（`ui/feedback.tsx`），Windows runner 慢一拍
  就错过，grok 的保存用例因此偶发 30 秒超时而同组 gemini 2.5 秒通过。记录带消费游标，
  第二次保存不会被第一次留下的 toast 顶掉；断言与超时都没有放宽。
