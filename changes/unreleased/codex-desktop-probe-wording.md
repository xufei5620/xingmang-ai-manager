## 开发

- Codex 桌面端检测没查成时，原话不再上屏（11-18 客户截图「Windows Appx 探测返回数据格式无效」）。
  `codex-desktop.ts` 解析查包结果时，空输出、不是 JSON、条目都不合格这几种改写英文摘要
  `Codex desktop package probe: unrecognized result (…)`，原输出（最多 600 字）放进 `detail`；
  脚本写进 `error` 的只认写给客户的那一句（`codexDesktopPackageProbeAccountMessage`，脚本照同一份拼），
  别的说法也改成摘要。合并脚本里查包那段的 PowerShell 报错（`packageError`，中文系统上是中文）同样只进 `detail`。
  检测失败那行把 `detail` 接在摘要后面，`scan.completed`、`desktop.detection-failed` 两行日志照旧看得到原话；
  装、卸载抛的错把它挂成 `cause`。界面按新的零依赖模块 `codex-desktop-probe-failure.ts` 认摘要开头，
  认出来就换成「检测这个工具时出了错，原因已经记进日志……」那句，不再看后面是不是中文。
