## 用户

- 「检查」页新增「文件夹位置」一项：用户文件夹或软件数据文件夹被「C 盘搬家」一类工具挪到别的盘时，会直接说出是哪个文件夹被搬到了哪里，以及为什么写入 Key、保存设置会失败。遇到同样的原因时，报错弹窗也会给出这句大白话和「打开检查页」按钮，不再只显示一句看不懂的原文。
- 软件启动时没能确认自己是不是以管理员身份在运行时，「检查」页的「运行权限」一项会如实说明「已按管理员方式处理」和原因，不再显示和实际情况对不上的「当前以普通用户权限运行」。
- 日志写不进去时，「反馈」页顶上会提醒一句，这次打开软件后的日志照样能看、导出的反馈报告里也会带上，客服不会再收到一份空报告。

## 开发

- 可能没想到的问题第 8 条（诊断部分）：`windows-elevation.ts` 新增 `resolveWindowsCliExecutionModeDetailed` 与 `classifyWindowsExecutionProbeFailure`，令牌探测失败时把原因（超时 / 找不到 PowerShell / 被拦截 / 输出看不懂 / 其他）与耗时带出来；**判定不变**，失败仍然从严回退 trusted-only，原 `resolveWindowsCliExecutionMode` 签名与行为不变。归类只读 stderr，execFile 的 `Command failed: <命令行>` 会回显脚本本身（含 Add-Type），不能拿它归类。`main.ts` 的 `cli.execution-mode` 日志加 `elapsedMs` 与 `probeFailed`，失败另记一条 `cli.execution-mode.probe-failed`（warn，带截断到 300 字的上游原文）。检查页 `ADMINISTRATOR` 读启动时那次结果（`DiagnosticsDependencies.windowsExecution`，不重跑探测）。反馈报告「运行权限」一行（#358）接上原因：`FeedbackRuntimeInput.executionProbeFailure`，探测失败写「按管理员处理（没能确认：原因）」，探测成功的 trusted-only 直说「以管理员身份运行」，缺省保持旧的「或无法确认」。
- 可能没想到的问题第 7 条（诊断部分）：`safe-local-data.ts` 新增只读的 `findReparseComponent`（与 `assertNoReparseComponents` 同一套逐级判定，I8 校验一行未改）；`diagnostics.ts` 新增 `FOLDER_RELOCATED`，查用户文件夹、userData、四家 CLI 配置目录，按被重定向的那一级合并；`operation-error.ts` 新增 `folderRelocated`，排在 `permission` 之前。
- `runtime-log.ts`：追加失败不再 `.catch(() => undefined)` 吞掉，记下中文原因与丢失条数，最近 200 条留在内存里并入快照与反馈报告；`RuntimeLogSnapshot.writeFailure` 为可选字段，缺省 = 旧行为。反馈页据此出一条提醒（`runtimeLogWriteNotice`）。
