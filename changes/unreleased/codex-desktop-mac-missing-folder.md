## 用户

- 修复了 Mac 上原项目文件夹被删除或移动后，Codex 桌面端无法打开的问题。

## 开发

- Mac 上首页 Codex 桌面端卡片点「打开」，主进程（`codex-desktop-service.ts` 的 darwin 分支）拿记住的项目文件夹
  （`AppSettings.workspace`，客户最近一次在星芒里选的那个）做 `assertWorkspaceDirectory`，文件夹被删或挪走就抛
  「项目文件夹不存在，请重新选择」（0.2.24 是「工作目录不存在」）。这张卡不弹选择器（Codex 自己管项目），渲染层也没有
  命令行那几张卡的 `isMissingWorkspace` 退回，错误框里「重试」还是同一句，客户怎么点都打不开（2026-11-25 0.2.24 Mac 截图）。
  Windows 分支一直是文件夹不在就不带深链打开。
- 现在 Mac 跟 Windows 一样：新加 `workspace-access.ts` 的 `existingWorkspaceDirectory`（不在、不是文件夹返回 null），
  `buildMacosCodexAppLaunchPlan` 的 workspace 可以是 null，这时只 `open -a <app> --env CODEX_HOME=…`，不带
  `codex://threads/new?path=` 链接，也不设 cwd；Codex 回到它自己上次的项目。Mac 上不让看（EPERM / EACCES）照旧报
  授权那句（D29），文件夹还在，不带它打开会让人以为项目丢了。
- 用例：`system-service.test.ts` 原来的「rejects a stored workspace that is not an existing directory」改成
  「opens the Darwin desktop app without a folder when the remembered one is gone」（旧代码上红）；借缺文件夹当停点的
  ChatGPT 官方账号那条改成真走到打开。`macos-codex-app.test.ts`、`workspace-access.test.ts` 各补无文件夹的用例。
  没加新字、没加通道，命令行工具和 Antigravity 命令行不在这次里。
