## 用户

- Windows 上点了 Codex 桌面端的「打开」，在它等窗口出来、换中文界面的那一分多钟里切换账号、退出或重新登录，不会再等 30 秒后报「账号服务请求超时」。Codex 照常打开。

## 开发

- #1085 后半：`launchCodexDesktop` 拆成两段，`launchThenWaitOutsideAccountWork` 只把发出启动请求为止的那段交给 `accountWork.run`；等窗口、注入中文仍在安装队列里（I11 不变），但不再算账号工作，换账号的 quiesce 不等它。这段里没等到窗口、要补连加速之前先问 `QueuedAccountWork.isCurrent()`：点「打开」以后换过账号或正在换，就不替上一个账号连加速，只照普通方式再开一次。
