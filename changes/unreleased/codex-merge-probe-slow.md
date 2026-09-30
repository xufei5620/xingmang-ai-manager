## 用户

- Windows 上检测 Codex 桌面端快了：以前可能要等二十多秒，慢一些的电脑上还会等到超时、报读不到安装信息。

## 开发

- Codex 桌面端合并探测（开始菜单 + 进程 + Appx 三段一条脚本）在 `trustedCommandEnvironment()`
  下要 23～29 秒，上限 24 秒：CI runner 上 #714 之后的打包作业实测 29.1 秒，正式代码里会超时。
  原因同 #714：收紧环境下任一条 cmdlet 走自动加载就要重建整份模块分析（约 22 秒）。#714 试过先导入
  Management / Utility / CimCmdlets / StartLayout 四个模块不见快，漏的是 `Get-AppxPackage` 所在的
  `Appx`——只要还有一个模块靠自动加载，代价就一分不少。
- 修法：`buildCodexDesktopCombinedProbeScript` 开头按名字导入 `codexDesktopCombinedProbeModules`
  五个模块（含 Appx）。仍只经收紧后的 PSModulePath 解析，没放宽环境变量，也没调大 24 秒上限；
  导入失败退回自动加载即旧行为。
- 单元测试把脚本里出现的每条 cmdlet 对到模块名，新加 cmdlet 忘了导入会红；打包作业冒烟里合并探测
  在收紧环境、按它自己的 24 秒上限变成真检查，另把自动加载关掉再跑一遍，漏导入的命令会按名字报出来。
