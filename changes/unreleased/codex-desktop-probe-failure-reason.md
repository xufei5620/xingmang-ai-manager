## 开发

- Windows 上查 Codex 桌面端装着哪一版的那条 PowerShell 失败时，日志以前只记得下错误原话的前 240 个字，
  而原话开头就是整条命令行（探测脚本本身），所以超时、退出码、报错原文全被截掉；更新、安装、卸载因此失败时
  只能说「没查出是哪一步」。现在探测结果改记成一句不带命令行的摘要（几秒没答复被结束 / 退出码几 / 被什么信号结束），
  powershell.exe 的原始错误（含 stderr、退出码、是否超时）挂成 cause 进运行日志；首页合并探测失败那句同样改成摘要。
  客户看到的字不变。`electron/codex-desktop-service.ts` 的 `describeCodexDesktopProbeProcessFailure`、
  `codexDesktopPackageProbeError`。
