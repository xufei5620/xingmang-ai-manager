## 用户

- 有的 Windows 电脑上点 Codex 桌面端「更新」，每次都报「没查出是哪一步出了问题」。更新前查装着哪一版，
  现在跟首页检测用同一种查法，不再几条查询同时挤着跑。

## 开发

- Windows 上装或更新 Codex 桌面端之前，`installCodexDesktopFromSources` 以前同时起四条 PowerShell（查包、开始菜单、
  进程各 8 秒，商店可用性 10 秒）。10-28 一位客户（0.2.22）每次点「更新」都死在查包那条，整步 10.2 秒，跟商店那条的
  10 秒时限对得上；首页那条合并脚本在同一台电脑上答得出来，「更新」按钮就是它给的。现在前三样改用首页同一条合并脚本
  （`runCodexDesktopCombinedProbe`，24 秒，三段解析与分开跑时一致），商店那条等它答完再起，顺序收在
  `inspectCodexDesktopBeforeInstall`。时限、环境变量、脚本内容都没改；正常电脑上多等一条商店查询的时间（约半秒）。
- 合并脚本整体失败时，`buildCodexDesktopCombinedProbeFailure` 把 powershell.exe 的原始错误挂成 `packageProbe.cause`，
  更新前查版本失败的日志和 #1512 一样看得到超时、退出码和 stderr。
- 装完以后的核对（`verifyInstalledCodexDesktop`）和卸载仍单独跑查包那条（8 秒），这次没动：那时没有别的 PowerShell 同时在跑。
