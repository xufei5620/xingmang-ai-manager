## 开发

- Antigravity 接中转第六步，界面还没接：桌面端安装器。新的 `antigravity-desktop-release.ts` 读桌面端自己更新时读的
  `manifest/latest-<x64|arm64>-<win|mac>.yml`（逐行读，地址必须是按版本和构建号拼出的谷歌存储原址，大小、SHA-512 都要有）。
  Mac 上在 `macos-desktop-app-installer.ts` 的来源表里加 `antigravityDesktop`（zip、团队 EQHXZ8M8AV、bundle
  `com.google.antigravity`，照旧核 Developer ID 和公证）；Windows 上新的 `antigravity-desktop-windows.ts` 下谷歌签名的
  NSIS 安装包，对大小、SHA-512，按 agy 那条核谷歌签名，运行前再对一遍 SHA-256，静默装到
  `%LOCALAPPDATA%\Programs\antigravity`；管理员身份打开的星芒不装。还没有存储桶那一路。2026-11-23 在 GitHub 临时机器上核过
  2.34.0：两种 Windows 安装包都是 Google LLC / DigiCert G4 签的，开着时再装会先关掉它；两种 Mac zip 解开都过星芒那条签名要求和 Gatekeeper。
