## 用户

- 部分 Windows 电脑上，刚装好的 Grok 和用官方方式装的 Claude Code 被说成不能卸载，现在能直接卸了。

## 开发

- 0.2.25 总单第 40 项（11-18 复核 D17）：Windows 普通身份下，星芒把 Grok 装进个人文件夹（`os.homedir()`，也就是 USERPROFILE）下的
  `.grok\bin`，可首页判断能不能卸（`system-scan-service.ts` 传给 `cliUninstallCapability` 的 `homeDirectory`）和真去卸
  （`cli-uninstall-service.ts` 的 `uninstallNativeGrok`）都先看 HOME。客户设了 HOME（Git for Windows、MSYS 常见，常指到别的盘）
  就对不上：刚装好的那份被判成「当前安装来源或目录不支持安全自动卸载」。
- 新模块 `electron/cli-user-home.ts` 的 `resolveCliUserHomeDirectory`：Windows 上取 USERPROFILE（缺了退回 `os.homedir()`），
  不看 HOME；macOS、Linux 上照旧取 HOME。装（`cli-install-service.ts` 的原生 Grok 落点）、判断、卸三处都改用它。
  macOS、Linux 上三处取到的值和原来一样；Windows 上只是从 HOME 换成个人文件夹，路径、签名、属主这些卸载前的核对一条没少。
- 同一个 `homeDirectory` 也决定官方安装器装的 Claude Code（`%USERPROFILE%\.local\bin`）能不能卸：设了 HOME 时它也被误判，
  这次一起好了；真去卸的 `uninstallNativeClaude` 本来就按 `os.homedir()`，不用改。
- 用例：`electron/system-service.test.ts` 设一个跟个人文件夹不同的 HOME，走一遍卸载 Grok，在旧代码上红（报的正是上面那句）；
  只改两个调用点里的一个也红。三个平台都跑，Windows 上按真的文件名（`grok.exe`、`agent.exe`、`version.json`）。
  `electron/cli-user-home.test.ts` 钉住两种平台各取哪个变量。
