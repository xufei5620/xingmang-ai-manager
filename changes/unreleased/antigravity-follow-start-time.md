## 开发

- 复查 A 第 2 轮第 2 条（一）：Windows 上「Antigravity 正在运行，请先退出」以前靠一个记号：后台改写设置时开着就
  记上，只有星芒自己在它没开着时打开才清。客户自己关掉、从开始菜单重新打开的（资源管理器给的已经是新设置），再点
  「打开」照样被请关掉。现在 `antigravity-service.ts` 记最近一次改写的时间，打开前列出开着的那份每个进程的启动时间
  （进程探测脚本每项多一个 `started`，FILETIME 字符串，哈希表加 DateTime 自己的方法，受限语言模式也放行），起得比
  改写早（或读不出启动时间）的才请关掉；后台跟的那一轮不再为此多起一次 PowerShell。
  `e2e/windows-powershell-probes-smoke.mjs` 那条真开替身的检查跟着核启动时间，两种语言模式要一致。
- 复查 A 第 2 轮第 2 条（二）：换账号、换线路以后替 Antigravity 改完设置，以前借 `network:relay-route-changed` 叫
  界面，界面就把三个外部客户端重新检测一遍（卡片闪「检测中」）、再重读设置和配置。现在另发
  `antigravity:settings-followed`（主进程发给界面的事件，载荷为空，不是界面能调的通道），`useToolbox` 只重读
  Antigravity 两张卡。
