## 开发

- 总单 Q4 C2：记录详情里每一轮最后那条 AI 回复挂一个可选字段 `activity`（跑了几条命令、程序名、
  改成了几个文件、文件名、几步没成功），不加通道。新模块 `electron/session-activity.ts` 读
  Claude Code 的 tool_use / tool_result 和 Codex rollout 的 function_call / custom_tool_call /
  local_shell_call 及其输出；只交出程序名和文件名，命令全文、文件夹、像密钥的名字都不出主进程。
  Grok CLI 的记录格式这次没核实，先不读；导出对话不带这一行。
- 给客户看的那句并进了 `r3-sessions-search-rescan.md`（同在记录页），这一版「## 用户」合起来不超 60 条。
