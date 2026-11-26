## 开发

- Windows 上 Codex 桌面端打开时，激活接口（`ActivateApplication`）回 WinINet 网络错误码（0x80072EE2 超时，另认
  0x80072EE7 / EFD / EFE / EFF，跟商店安装那一路认作「无法连接微软商店」的是同一组）、一直没给过进程号时，打开失败改报
  「Windows 打开 Codex 前需要联网向微软验证，本次验证超时……网络恢复后重新打开即可」，错误框归到新的
  `codexDesktopActivationOffline`（标题「网络不稳定，Codex 未能启动」），按钮只有「重试」「检查网络」「联系客服」，
  不给「重置 Codex」「立即重启」。依据：2026-11-23 一台 Win11 家庭版 26H2 26300.10075，商店签名包打开前要联网核对许可，
  网络断着时激活回 0x80072EE2、AppModel-Runtime 事件 203「[LaunchProcess]」，开始菜单直接点也打不开；网络一好同一个包就能开，
  跟家庭版无关。以前这种落在认不出原因的「Codex 打开失败」，叫客户去重置、重启，白折腾。认码在 `codex-desktop-cdp.ts` 的
  `isCodexDesktopActivationNetworkFailure`（跟 `isCodexDesktopActivationNotRegistered` 共用沿 cause 链看 message 和 stderr 的那段），
  归总在 `buildCodexDesktopActivationFailureSummary` 的 `windowsActivationOffline`；两种码都出现时先说网络。没加 IPC 通道。（yoyo「联网框改」）
