## 用户

- 检查页「导出检查报告」、反馈页「导出文件」、记录详情「导出 Markdown」成功之后，提示条上多了一颗「打开所在位置」：点一下就在资源管理器 / 访达里打开导出的文件夹并选中那个文件，不用再照着路径一层层去找。文件导出后被挪走或删掉了，按钮旁边会说一句，上面那句「已导出」和路径仍然留着。
- 反馈报告日志太多、超过大小上限时，不再报「反馈报告过大，请减少日志后重试」（反馈页并没有「减少日志」这个动作）。现在自动从最旧的日志开始去掉，直到装得下，并在报告开头写明「只保留最近 N 条」；完整日志仍在「打开日志目录」里。
- 反馈页导出成功的提示从「诊断报告已导出」改成「反馈报告已导出」。
- 记录页里只剩摘要、看不了全文的记录（部分 Grok 记录、原文件已经不在的 Codex 记录），「查看记录」按钮不再只是灰着，鼠标停上去会说明原因。

## 开发

- 第八批候选 5、6。新通道 `exports:reveal-file` / `revealExportedFile`（三份表同步，T1，排在 `runtime-logs:export-feedback` 之后），经 `registerTrustedHandler`（I4）。入参是路径字符串，但**只认本进程最近 16 次导出写出的路径**：`diagnostics:export`、`runtime-logs:export-feedback`、`provider-sessions:export`、`sessions:export` 成功后把返回的 `outputPath` 记进 `ipc.ts` 闭包里的名单，取消的导出不记。渲染层给名单以外的路径一律拒绝，不会让资源管理器指向任意位置。
- 新模块 `electron/exported-file.ts` 的 `resolveRevealableExportedFile`：绝对路径、`lstat`（不跟随链接）后必须是普通文件，否则报「已经不在原来的位置了」/「不是导出的那个文件」。`showItemInFolder` 只选中不运行，所以不照搬 `config-directory.ts` 的 reparse 全路径拒绝。`registerIpcHandlers` 多一个可选注入 `revealInFolder`，缺省 `shell.showItemInFolder`。
- `RuntimeLogStore.captureFeedbackReport(limit, maxLength?)`：超过 `maxLength` 时按条从最旧的日志开始丢，头部加一行「日志已截断: …只保留最近 N 条」，并把「日志条数」行改成附最近 N 条；只有日志以外的部分就超限时才抛错，文案指向「打开日志目录」。`runtime-logs:preview-feedback` 传 `FEEDBACK_REPORT_MAX_LENGTH`（2,000,000，与原判断同一口径：UTF-16 长度）。
- 渲染层：`useOperation` 的成功回调可以返回 `{ text, revealPath }`，hook 多暴露 `revealPath`；`ResultNotice` 收可选的 `revealPath` + `onReveal`，两者都在且是成功态才出按钮，定位失败只在按钮旁边写一句、不顶掉成功提示。记录页「查看记录」在 `detailAvailable === false` 时带 `title` 说明，并加 `testId`。
