## 用户

- 安装或更新 Codex 桌面端时，先从微软商店装；商店这次没装上，会自动改用国内镜像下载，并一直显示为什么换了线路。

## 开发

- `codex-desktop-service.ts`：Windows 安装/更新先走 `winget install --id 9PLM9XGG6VKS --source msstore`（winget 路径只取 `resolveSystemWingetExecutable` 校验过的 App Installer 包目录，argv 固定，当前用户身份运行，15 分钟上限），以本机实际装着的包版本判断成败；失败则按原顺序退到国内镜像 → 镜像备用源 → 上一版本，镜像下载、校验逻辑一行未动。更新时只有官方清单比本机新（或清单没读到）才试商店。
- 新增纯函数 `buildCodexDesktopStoreInstallCommand` / `describeCodexDesktopStoreFailure` / `parseCodexDesktopStoreProgress` / `shouldTryCodexDesktopStoreUpdate` / `describeCodexDesktopDownloadAttempt`；换线路的原因（商店没装上、国内镜像不可用）整段下载都显示，不再在 0% 之后被盖掉。镜像也失败时报错同时写出两边的原因。
