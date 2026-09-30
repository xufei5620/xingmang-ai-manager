## 用户

- 没有微软商店的电脑（企业版 LTSC、精简版系统、公司关掉了商店）装 Codex 桌面端时，星芒会先认出来，直接用国内线路装，进度里写「这台电脑没有微软商店，直接用国内线路装」，不再先空等商店那一步。装不上时错误框不再给那颗按了打不开的「去微软商店装」，只留「重试」「查看日志」「找客服」。
- 商店在、但少一个安装组件的电脑，进度里改说「微软商店少一个安装组件，先用国内线路装」。
- Windows 版本太旧装不了 Codex 桌面端时，直接说清楚，建议先用 Codex CLI 或把 Windows 更新到最新，不再叫你反复点「重试」。
- 教程里「要求去微软商店」那一条改成：没有微软商店也能装，装不上时按错误框里的按钮走。

## 开发

- 第二十一批 2。`windows-store-app-launch.ts` 新增 `inspectWindowsStoreAvailability`（异步 execFile，只读当前用户的 `Microsoft.WindowsStore` 包和 `RemoveWindowsStore` 两条策略键；查不出来返回 null，照旧先走商店）。`codex-desktop-service.ts` 安装入口与包探测并行调用它（可注入 `inspectStoreAvailability`），为 false 时跳过 `installCodexDesktopFromStore`，并且不再给出 `storeNewerVersion`；首页合并探测没动，不多起 PowerShell。
- `CodexDesktopInstallAttempt` 新增可选 `storeUnavailable` / `storeInstallerMissing`，进度前缀统一由 `describeCodexDesktopStoreNotice` 出。`codex-desktop-install-failure.ts` 新增 `unsupported` 原因（0x80073CFD / 原话里的「requires OS version」，排在 blocked 前）和 `codexDesktopNoStoreNotice`；渲染层 `operation-error.ts` 新增 `codexDesktopTooOld`、`codexDesktopInstallNoStore` 两类，前者只给「查看日志」「找客服」，后者没有「去微软商店装」。
- 0x80073CFD 的原话与「商店不在时 winget 那一步」都是推测，没在 LTSC 或老 Windows 10 真机上演过。
