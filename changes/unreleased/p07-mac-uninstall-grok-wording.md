## 开发

- P07 / D8（`0.2.24-深查/Mac.md` M2）：Mac 卸载星芒勾「连同星芒替你装的命令行工具一起删」后的提醒不再说会删
  Grok CLI。`removeMacManagedTools` 只删 `~/Library/Application Support/XingMangAI`，Grok 在 `~/.grok`，
  客户自己用官方脚本装的也在那里，按决定单选 a 只改字不多删：`AppUninstall.tsx` 的 `appUninstallRemoveToolsWarning`
  换成决定单上逐字批的那句，`macos-uninstall.ts` 里说「Grok 也在这个目录」的注释改对，测试钉住新句子。
