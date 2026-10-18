## 开发

- 对话记录导出成 Markdown 的写法只留一份：`codex-sessions.ts` 和 `provider-sessions.ts` 原先各抄一遍的
  落盘位置、文件名、开头几行、不完整标注和临时文件原子替换，收进新的 `session-markdown-export.ts`，
  两边只管找到记录、逐条读消息。导出的文件内容、默认文件名和报错一字不变，两边各加了逐字比对的测试钉住
  （#1073 第 4 条）。
