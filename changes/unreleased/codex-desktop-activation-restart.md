## 开发

- Windows 上 Codex 桌面端「装好了、点了没反应」：激活接口（`ActivateApplication`）回 0x80270254
  「应用未安装」、当前用户的包却装着、一直没见进程时，打开失败改报「Codex 已安装，但 Windows 未能启动它」，
  错误框归到新的 `codexDesktopActivationBroken`（标题「Codex 未能启动」），第一颗按钮「立即重启」，不给「重置 Codex」。
  依据：2026-11-21 一台 Win10 家庭版 19045.6456 的排查记录（重新注册、覆盖安装、完整重装都无效，重启才好）和
  openai/codex #57691（Win10 专业版，同一版本号）。认码在 `codex-desktop-cdp.ts` 的 `isCodexDesktopActivationNotRegistered`
  （沿 cause 链看 message 和 stderr，PowerShell 的 CLIXML 前缀会把码挤出 500 字的外层消息），归总在
  `codex-desktop-service.ts` 的 `buildCodexDesktopActivationFailureSummary`；最后一次激活报的错挂在打开失败的 cause 上，
  普通打开那一路的激活报错以前只打控制台、打包版不留，现在进运行日志。（yoyo「重启框改」）
- 认不出原因的「Codex 打开失败」框在「重置 Codex」后面补一颗「立即重启」（yoyo「加重启」）。两处的「立即重启」都弹
  `RuntimeRestartDialog` 的 `reason="codexDesktop"` 那一版（同一次 `runtime:restart-windows`、同样两道闸，不挂 Node.js
  那条「需要重启电脑」的页顶提醒），没加 IPC 通道。
- Windows 重启倒计时里那句 `shutdown /c` 从英文「to finish Windows updates」改成通用的
  「星芒AI管理工具将重启电脑，请保存未保存的文件。」（`windowsRestartNotice`，Node.js 装完那次也用它）。
- 普通「Codex 打开失败」框下方那句主进程原话改成正式口吻，开始菜单里要搜的名字改用 `Get-StartApps` 查到的
  那一项的 Name（新版是「ChatGPT」，以前写死「Codex」，客户搜不到会以为没装上），名字看着不对或查不到时仍写「Codex」
  （`resolveCodexDesktopStartMenuName`）；Windows 交回过进程号、到头却没有进程的那种改说「启动后随即退出，未出现窗口」。
  名字随这次打开查出来的状态走（闭包里的 WeakMap），没加进 `DesktopAppStatus`，渲染层拿不到也用不上。（yoyo「开始菜单改」）
