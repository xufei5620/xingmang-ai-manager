## 开发

- 深查 D24、D25（批次 Z18）。`node-runtime.ts` 装 MSI 那一步的进度改由 `nodeRuntimeMsiInstallingMessage` 给出：缺省说会弹授权窗口；`InstallNodeRuntimeOptions.processElevated` 为真（星芒本身带着管理员权限在跑，`windows-elevation.ts` 的 highIntegrity，已知19）时保留原来的「正在静默安装」。`main.ts` 经新的 `SystemServiceOptions.windowsProcessElevated` 传给运行环境卡和装工具时顺带装 Node.js 的两条路。
- `codex-desktop-service.ts`、`claude-desktop-msix-installer.ts` 走提权那一刻的提示换成 D25 那句，点明授权框上写的是「Windows PowerShell」。
