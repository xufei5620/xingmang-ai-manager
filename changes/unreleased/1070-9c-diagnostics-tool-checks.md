## 开发

- 拆 `diagnostics.ts`（#1070 第 9 步，第三块）：「运行环境与工具」那几项（Node.js、它自带的安装组件、Python、Git、各家命令行工具、Codex 桌面端、各家工具的连接设置）连同只有它们用的小工具（项目名表 `runtimeCheckTitles`、Codex 桌面端单独探的 PowerShell 脚本和 `defaultInspectCodexDesktop`、`providerOutcome` 和它用的线路比对、Codex 后台常驻的说法、`reconcileNodeRuntimeWithClis`）搬进新文件 `electron/diagnostics-tool-checks.ts` 的 `buildToolChecks(context)`；`runDiagnostics` 的检查清单里换成 `...buildToolChecks(context)`，次序不变，收尾时照旧调 `reconcileNodeRuntimeWithClis`。新文件只 import `diagnostics.ts` 的类型，搬走的四个导出名 `diagnostics.ts` 照旧转出。
- 搬运用脚本按原文件行号整段复制，逐段比对一字没改。Windows 专属的那段原样搬过去，没改：Codex 桌面端单独探时只用 `resolveWindowsPowerShellExecutable` 给的可信路径、跑在 `trustedCommandEnvironment` 下，脚本开头先按名字导入四个模块，只认当前账号自己的应用注册（不用 `-AllUsers`）。
- 测试：这几项的行为由 `diagnostics.test.ts` 原有的用例钉着（下线的 Gemini 不出这两项、首页扫描的复用、连接设置和线路、Codex 后台常驻、没装命令行工具时 Node.js 降级），Codex 桌面端那段脚本由 `powershell-module-imports.test.ts` 照旧从 `diagnostics.ts` 拿来查；另用八种情况把整份报告和日志搬前搬后各跑一遍逐字比对，一样。
