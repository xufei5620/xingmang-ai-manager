## 用户

- 遥控现可继续电脑上已有的 Codex 对话。

## 开发

- 手机遥控能接本机 Codex 已有的对话（yoyo 2026-11-22 北京 13:15 回「接对话字改」，29 句新字逐字照用）。
  电脑页「通用设置」在「工作文件夹」下面加「手机端的对话」一行和「选择对话」弹框，列 Codex `thread/list`
  最近 20 段（桌面端、CLI 和遥控自己开的都在，去掉临时的和子任务的）；手机上新加「对话」「对话 N」两条指令，
  只列电脑端已添加的文件夹里的 10 段。选定的那段记在 `codex-remote` 设置的 `conversation` 字段
  （编号、标题、文件夹、更新时间），文件夹不是当前干活的文件夹时不算数。
- 接上靠 `thread/resume`（`excludeTurns`，跟新开的对话一样关掉 apps、plugins，带上星芒管的 MCP）；
  原对话的审批方式、审批人或沙箱超出手机遥控这一档（`resumedPermissionFits`）时，第一轮 `turn/start` 就带上
  这一档的 `approvalPolicy` / `approvalsReviewer` / `sandboxPolicy` 降下来，之后电脑上接着用也是这档。
  手机遥控的规则（不发密钥、回复简洁）在第一轮由 `collaborationMode.settings.developer_instructions` 带进去，
  所以 `initialize` 改成 `experimentalApi: true`；只认 Codex 0.169.x（`codexSupportsResume`），别的版本两边都说不支持。
- 新加两条主窗口通道（I5：渲染层只给对话编号，文件夹由主进程从上一次列出来的结果里取，再过
  `validateRemoteWorkspace`）：`codex-remote:list-conversations`（成功不记日志，遥控关着时临时起一个 Codex 读完就关）、
  `codex-remote:choose-conversation`（入参 `null` 或对话编号，`parseRemoteConversationChoice` 校验）。
