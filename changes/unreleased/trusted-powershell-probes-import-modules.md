## 用户

- Windows 上又一批检测不再因为电脑慢就等不及：装、更新、卸载前看工具开没开，检查页的 Codex 桌面端、代理设置，打开 Codex 桌面端，Claude 桌面端等客户端的检测，加速的开关，装 Node.js / Python / WorkBuddy 前的官方签名核对，以管理员身份打开时的工具窗口，都比以前快，不会再无故报「读不到」或直接跳过。
- 以管理员身份打开星芒时，慢一些的电脑上偶尔会把装在系统目录里的 Node.js、Git 当成「不安全」而拒绝使用，检查页也读不出它们的版本；现在不会再因为检测等不及而误判。

## 开发

- #714 / #716 / #718 同一个根因的收尾：全仓所有在 `trustedCommandEnvironment()`（或同样把 PSModulePath
  收窄到 System32 的 `windows-machine-paths` ACL 探测）下跑、又调用了引擎核心以外命令的 PowerShell 脚本，
  开头都按名字导入自己用到的模块。涉及 `cli-process-probe`、`diagnostics`（检查页 Codex 桌面端）、
  `codex-desktop-cdp`（端口探测、激活）、`external-client-runtime`、`uninstall-cleanup`、
  `claude-desktop-manifest` / `-policy`、`stale-proxy-environment`、`platform/windows-system-proxy`、
  `node-runtime`（待重启、App Installer、两条签名核对）、`python-runtime`、`workbuddy-installer`、
  `trusted-native-cli`、`trusted-temp`（受保护目录 ACL 回读）、`windows-machine-paths`（两条 ACL 探测）、
  `windows-elevation`（打开工具的中转脚本与终端脚本）。没放宽环境、没调任何上限。
- 签名核对原本用 `Join-Path $PSHOME ...` 导入 Security，而 `Join-Path` 本身就在 Management 模块里，
  这一句就会触发整套扫描；改成字符串拼路径（`buildPowerShellPinnedModuleImportStatement`），保留
  `-Force -ErrorAction Stop`，并把 ConvertTo-Json 所在的 Utility 一起按同样方式导入。
- `buildPowerShellModuleImportStatement` 挪进新的叶子模块 `powershell-module-imports.ts`（`windows-machine-paths`
  也要用，放在 `windows-elevation` 会成环），模块名只认字母数字和点，其余直接拒绝。
- 新增 `powershell-module-imports.test.ts`：二十多条脚本逐条把命令对到模块、逐个去掉一个导入确认会红、
  不多导；另钉住四条不调命令的脚本保持不调。打包作业冒烟里这些探测按各自上限在收紧环境下做真检查并打印
  耗时，另关掉自动加载各跑一遍，漏导入的命令按名字打印；该步骤上限 6 → 12 分钟。
- 没动的：`windows-elevation` 的 Add-Type 令牌探测（提速清单 A1）、Codex Appx / Node.js 的提权安装中转
  （15 分钟或不限时，提权子进程环境另算）、`knownFoldersFromWindows`（PSModulePath 为空的兜底路径）。
