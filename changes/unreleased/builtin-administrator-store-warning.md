## 用户

- 撤掉一条误报：用 Windows 自带「Administrator」账户登录的电脑，检查页「运行权限」不再黄着说「从微软商店装的软件（比如 Codex 桌面端）可能打不开」，首页、「安装卸载」页和新手引导里 Codex 桌面端那行也不再这样提醒；在这种账户下 Codex 桌面端实测能装、能打开。关了「用户账户控制」的电脑上的同一句提醒也一并撤掉。万一 Codex 桌面端真没打开，错误框照常给「重试 / 重置 Codex / 找客服」，不再先怪账户。

## 开发

- `electron/windows-store-app-launch.ts` 删掉账户探测（`WindowsStoreAppLaunchContext`、`resolveStoreAppLaunchBlock`、`describeStoreAppLaunchBlock` 及其 PowerShell），只留「有没有微软商店」（#674）。Windows 那条「内置管理员 / 关了 UAC 不能激活」（E_FULL_ADMIN_NOT_SUPPORTED 0x80270253、E_UAC_DISABLED 0x80270252）只管跑在 AppContainer 里的 UWP 应用；Codex 桌面端是 runFullTrust 的 MSIX，按普通桌面进程启动。内置 Administrator 真机核过：2026-10-02 出过这句提醒的租用测试机（SID -500、FilterAdministratorToken ≠ 1）上 Codex 桌面端装好并打开过。EnableLUA = 0 没真机核过，依据是同为 full-trust MSIX 的 Windows Terminal 在 EnableLUA = 0 的 Windows 10 上能启动（microsoft/terminal PR #11221、#17291）。
- `diagnostics.ts` 的 `ADMINISTRATOR`：alwaysElevated 那支恢复 #473 的 pass，不再多起一次 4 秒的 PowerShell；`DiagnosticsDependencies.inspectStoreAppLaunchContext` 删除。
- `codex-desktop-service.ts`：首页合并探测不再读当前账户与 UAC 策略，`DesktopAppStatus.storeAppLaunchBlock` 与 ipc-contract 的 `StoreAppLaunchBlock` 删除；`describeCodexDesktopLaunchFailure` 去掉账户参数，打开失败后不再额外起一次最长 10 秒的账户探测。
- 渲染层删掉 `storeAppLaunchNotice` / `storeAppLaunchShortNotice` 与首页、安装卸载页、新手引导三处挂载；`operation-error.ts` 删掉按「Administrator / 用户账户控制」隐藏「重置 Codex」的特例。`e2e/windows-powershell-probes-smoke.mjs` 去掉账户探测那两项。
