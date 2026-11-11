## 用户

- Windows 上装或更新 Codex 桌面端时，如果是因为这台电脑的 Windows 防火墙服务被停掉才装不上，现在会直接说清楚，不再叫你反复重试或去微软商店装，也不会先换一路把几百兆的安装包再下一遍才告诉你；微软商店只是还没有新版时，也不再说成「商店没装上」。

## 开发

- `codex-desktop-install-failure.ts` 新增 `firewallOff`：Add-AppxPackage 的 0x80073CF6 里带 0x800706D9（注册 `windows.firewallRules` 扩展时防火墙服务 MpsSvc 没在跑）单独归一类，排在 `blocked` 前面；只认错误码，因为 PowerShell 按控制台宽度把扩展名折成两半（2026-11-06 客户日志是「windows.firewallRu\r\nles」）。这一类的失败句不带商店、官网两路的经过，也不说「原来那一版照常能用」。渲染层新卡 `codexDesktopFirewallOff`，只给「查看日志」「找客服」。
- 商店退出码 0x8a15002b（`codexDesktopStoreNoUpdateExitCode`，商店还没有比本机更新的版本）时，失败句开头从「微软商店这次没装上」改成「微软商店里还没有新版」；日志里那句原话不变。
- 存储桶的包交给 Windows 时就认出防火墙服务停着（`firewallOff`），`shouldContinueAfterCodexDesktopBucketInstall` 原样交出，不再接着走商店、官网：
  以前要多等商店一趟、再从 OpenAI 官网把同一个包下一遍，最后才出同一张卡（0.2.24 全面检查 P1）。商店那一路的退出码认不出防火墙
  （推测报的是通用的 0x80073CF6），桶没用上时照旧商店→官网，官网的包被拒以后本来就直接报错。
