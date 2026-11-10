## 用户

- 有些开着安全管控的 Windows 电脑上，首页 Codex 桌面端一直显示「检测失败」；现在能照常认出装没装、是哪一版。

## 开发

- Codex 桌面端的首页合并查询和查包脚本在 PowerShell 受限语言模式（WDAC / AppLocker 等应用控制策略开着时，
  `-Command` 一律跑在这个模式里）下也能跑完：开头设 UTF-8 输出那句只在 FullLanguage 下执行，受限模式下 JSON
  里 ASCII 以外的字符转成 `\uXXXX` 再输出（新叶子模块 `electron/powershell-constrained-language.ts`）。以前那句
  被拒，整条查询按退出码 1 退回、结果全丢，装着的 Codex 桌面端次次「检测失败」（2026-11-10 客户电脑）。
  受限模式下查进程那段仍查不到（用到 WindowsIdentity），只少「正在运行」这一项；Claude Desktop、OpenCode、
  WorkBuddy 的盘点脚本和安装脚本另开 PR。
