## 用户

- 替你改好的「做完弹通知」设置只提示一次：星芒打开时自动改好工具里这项设置以后，只在右下角说一句，几秒后自己收起，
  工具卡片上不再一直挂着这句。

## 开发

- 首页：主进程 `cliHooksAutoRepaired` 那一句从工具卡中间那行挪成右下角提示条，每家（Codex 命令行和桌面端算一家）这次运行只说一次（`Home.tsx` 的 `hookRepairsToAnnounce` / `cliHooksAutoRepairedText`）；说过的那几家另记在窗口的 sessionStorage 里，窗口缩在托盘久了界面重新加载（#1411）也不再说。原来整场开着都挂在卡片上，还顶掉了线路和版本（yoyo 2026-10-25 截图）。「修好它」那一档的说明同步改成客户读得懂的说法。浏览器用例 `a reminder setting fixed on startup is announced once and leaves the card line alone` 钉住。
