## 开发

- 改字批次 X37（D29）：Mac 上点「打开」时，星芒自己查工作目录拿到 EPERM / EACCES（「文件和文件夹」里没给星芒授权，文件夹其实还在），不再报「工作目录不存在，请重新选择」，改报 D29 那句，让客户把「星芒AI管理工具」和「终端」两项都打开。新模块 `electron/workspace-access.ts` 的 `assertWorkspaceDirectory` 管这一查，命令行工具（`provider-launch-service.ts`）和 Mac 上的 Codex 桌面端（`codex-desktop-service.ts`）共用；Windows、Linux 照旧当成不存在。新句子不带「工作目录不存在」，界面不再把授权问题当成目录没了退回选择器。推测，没在真机上核。
