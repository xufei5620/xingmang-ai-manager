## 开发

- 改字批次 Z07（W13 W15 W16 W53 W83 W84 W85 W86 W87 W88 D21 D59）：`App.tsx` 退出登录确认框按钮、Codex 已开着的那个框（标题、按钮、正文、`perform` 动作名）、中文界面问答框里的「其他用户」；`ConfigDialog.tsx` 来源标题、密钥下拉的标签、自动准备那一行的分组和预览、语言说明；`ExternalClientDialog.tsx` 手填密钥那一项；`external-model.ts` 别家设置的两种状态；`RequiredUpdateGate.tsx` 的按钮；`OfficialQuotaDialog.tsx` 的重置次数。
- `ManualUninstallDialog` 加可选 `onHelp`：没生成命令、或「帮我清理」没删干净时底部多一颗「找客服」（界面和功能页.md S12），帮助框叠在上面。`codexDesktopChineseUnverifiedMessage` 里点名的按钮跟着改成「重开 Codex」。
