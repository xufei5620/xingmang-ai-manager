## 用户

- Windows 上装 Codex 桌面端多了一条路：微软商店没装上时，先从 OpenAI 官网下离线安装包装，下不成再换国内镜像。
  只点一次「安装」，前一路不行自动换下一路。
- Windows 上 Claude Desktop 也能在没有系统自带安装组件的电脑上一键装了：系统组件装不上或电脑上没有它时，
  星芒从 Claude 官网下离线安装包，核对是官方签名的原版再装。两路都不行时，错误框里有「去官网下载」。

## 开发

- Codex 桌面端（`codex-desktop-service.ts`）：商店没走通（含没有商店）后先走 `downloadCodexDesktopOfficialPackage`，
  从 `persistent.oaistatic.com` 的官方 MSIX 下载，版本取官方 `windows-store-update.json`；包进 `withDownloadAcceleration` 临时加速线路，
  校验与镜像那一路同一套（`codexDesktopPackageValidationError`）。下不成、没过校验才换国内镜像，失败句多半句
  「OpenAI 官网的离线安装包也没下成」；官网的包下好核过却装不上时直接报错，不再换镜像重下。安装尾段抽成
  `installDownloadedCodexDesktopPackage` 两路共用。
- Claude Desktop（新 `claude-desktop-msix-installer.ts`）：入口 `claude.ai/api/desktop/win32/<架构>/msix/latest/redirect`，
  手动跟随至多三次跳转，只认 `claude.ai` 入口与 `downloads.claude.ai/releases/`；断点续传只找已落到的那个文件。
  下载后用 PowerShell 只读核对 `AppxManifest.xml` 与 Authenticode 签名：包名 `Claude`、架构、发布者算出的 ID 等于
  `Claude_pzs8sxrjxfjjc` 的后半截、签名 Valid 且签名者 `Anthropic, PBC`、签名主体与清单发布者一致。安装复用
  `codex-desktop-appx.ts` 的 `addWindowsDesktopAppxPackage`（带后台服务的包要 UAC 授权）。
- `external-client-runtime.ts`：Claude Desktop 在没有可信 winget 时也给「安装」；winget 除用户取消外怎么失败都先重新盘点，
  没装上就换官网那一路。两路都失败时由 `claude-desktop-install-failure.ts` 归成一句大白话，原话挂 `originalError` 进运行日志；
  渲染层新增 `claudeDesktopInstallFailed` 一类，按钮「去官网下载」打开 `https://claude.com/download`（已在外链白名单）。
- `e2e/windows-powershell-probes-smoke.mjs` 在 Windows CI 上用一个未签名的替身包真跑一遍核对脚本。
