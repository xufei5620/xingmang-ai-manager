## 开发

- `electron/windows-store-app-launch.ts` 改名 `windows-store-availability.ts`（测试文件同步改名，选项类型
  `WindowsStoreAppLaunchProbeOptions` 改成 `WindowsStoreAvailabilityProbeOptions`）：2026-10-02 撤掉账户探测后它只剩
  「这台电脑有没有微软商店」一件事，旧名说的「启动商店应用」早已不是它做的。`codex-desktop-service.ts` 的 import、
  `codex-desktop-service.ts` / `diagnostics.ts` 里指向它的注释、`e2e/windows-powershell-probes-smoke.mjs` 和模块地图跟着改；
  里面的 PowerShell 脚本和执行逻辑一行没动（#1140 第 5 条）。
