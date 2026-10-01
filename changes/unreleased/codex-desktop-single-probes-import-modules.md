## 用户

- Windows 上 Codex 桌面端的安装、更新、卸载、重置和「打开」更稳了：慢一些的电脑上，以前可能因为等不及就误报「读不到安装信息」「窗口没出来」，或者装好了却说没检测到新版本。

## 开发

- 跟 #716 同一个根因、同一个修法，补到 `codex-desktop-service.ts` 里其余的 PowerShell 脚本：开始菜单探测、
  扫描和关闭用的进程列表、「打开」与加速用的会话进程列表、Appx 包探测（各 8 秒上限），以及安装包检查
  （90 秒）、卸载、重置（各 2 分钟）。它们都跑在 `trustedCommandEnvironment()` 下，任一条命令走自动加载
  就要约 22 秒；Appx 包探测是安装、更新、卸载、重置的第一步，超时会直接报「读不到安装信息」。
- 每个脚本开头按名字导入自己用到的模块（导出的 `codexDesktop*Modules` 常量），没放宽环境、没调上限；
  导入失败退回自动加载即旧行为。开始菜单与卸载脚本抽成 `buildCodexDesktopStartAppProbeScript` /
  `buildCodexDesktopUninstallScript` 以便单测；8 秒上限收成 `codexDesktopSingleProbeTimeoutMs`。
- 单元测试把这八个脚本里的每条命令对到模块，并逐个去掉一个导入确认会红；打包作业冒烟里四条单独探测
  在收紧环境下按 8 秒上限做真检查，另把自动加载关掉各跑一遍，漏导入的命令按名字打印出来。
