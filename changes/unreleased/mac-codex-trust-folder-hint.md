## 用户

- Mac 上在 Codex 配置里点「信任当前文件夹」新加了信任时，会多说一句：Codex 开着的话，先在 Codex 窗口里按 Command + Q 完全退出，再回星芒点「打开」。

## 开发

- 第二十九批 A 的后续（#806 之后）：`locale-status.ts` 新增 `describeWorkspaceTrustResult(changed, os)`，`ConfigDialog.tsx` 按 `trustCodexWorkspace` 返回的 `changed` 选文案。
  只在 Mac 上、而且这次真的新加了信任时补这半句；Windows 由主进程替人重开 Codex，文案不变。
