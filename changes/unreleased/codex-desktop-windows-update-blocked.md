## 开发

- Windows 上 Codex 桌面端打开失败、一直没给过进程号，而 Windows 只回了超时（`ActivateApplication` 的 0x800705B4）或
  什么原因都没说（只走了开始菜单那一路）时，主进程再只读查一下 Windows 更新服务：`reg.exe` 读 wuauserv 的启动类型、
  `wevtutil.exe` 数系统日志最近一小时服务控制管理器的 7023（按 Binary 里的服务名认 wuauserv，param2 为
  `%%2147942405` 或 `%%5` 的拒绝访问）。被禁用或一小时里拒绝访问两次以上，打开失败改报「本机的 Windows 更新服务无法启动，
  Codex 首次启动所需的验证未能完成……临时开启 Windows 更新并成功打开一次 Codex 后，可重新关闭更新」，错误框归到新的
  `codexDesktopWindowsUpdateBlocked`（标题「Windows 更新已关闭，Codex 未能启动」），按钮只有「重试」「联系客服」。
  依据：2026-11-23 一台 Win11 家庭版 21H2 22000.2245，客户找人关了更新（给 `SoftwareDistribution\Download` 加了
  「所有人拒绝完全控制」，服务设置和策略都是默认），更新服务每 2 分钟以「一般性拒绝访问错误」退出，Codex 激活回 0x800705B4、
  自带的 CodexSandboxService 卡在 Start Pending；去掉那条拒绝 5 秒内两边都起来，加回去、重启以后照样能开。
  新模块 `windows-update-service-state.ts`（两个系统程序都用 System32 绝对路径、参数数组、只给系统目录的环境，读不到当没被拦），
  `codex-desktop-cdp.ts` 新增 `isCodexDesktopActivationTimeout`，`buildCodexDesktopActivationFailureSummary` 多一项
  `windowsUpdateSuspect`；查不查由 `inspectWindowsUpdateBlocked` 注入，缺省不查，生产由 system-service 打开。
  先后：联网验证、激活坏了在前，已知坏版本在后。不改任何系统设置，没加 IPC 通道。（yoyo「更新框改」）
