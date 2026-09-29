## 用户

- 「检查」页多了「安全证书」一项：看得出这台电脑有没有装公司或安全软件的证书、工具能不能正常认它；电脑上的 Node.js 太旧时给「去处理」直达「安装卸载」页。反馈报告里带同一句结论。没装 Node.js 时不出这一项。
- 「检查」页各项标题和结论改成大白话，比如「打开工具用的命令窗口」「电脑里另外设过的工具地址或密钥」「Codex 文件夹里的额外设置」「Claude Code 跑命令前要不要先问你」，系统一栏直接写「Windows 11（64 位）」「macOS 15（Apple 芯片）」。首页「运行环境」不再单列 npm，缺了才在 Node.js 那一行说一句。

## 开发

- 新增 `electron/certificate-trust-probe.ts` 与检查项 `CERTIFICATE_TRUST`：用跑工具的那个 Node 起两次 `node -e` 只做 TLS 握手连当前账号状态地址（去掉 / 强制 `NODE_USE_SYSTEM_CA=1` 各一次，5 秒超时，只打印固定标记），得出 direct / systemTrusted / outdatedNode / untrusted / elevated / unknown；管理员身份不起进程；「星芒 AI 网络」同时失败时改指向那一项。`CheckOutcome.omit` 让没装 Node 时不出这一行。`diagnosticTarget` 按 `details.verdict` 只给 outdatedNode「去处理」。检查项的 `code` 全部不变，只改 `title` / `summary`。
