## 开发

- `electron/external-client-runtime.ts`：同一个外部客户端装了两份、开着的是第二份时，星芒当它没开、照样改两份共用的那份配置
  （0.2.25 总单第 35 项，11-18 N10、全面检查 D-4）。按新代码重核：Windows 那一半 #1928 已经修掉（盘点脚本每条卸载登记都列出来，
  `status` 的 `running` 改成几份一起算），这次补一条用例钉住（两条登记先后对调结果一样）。剩下的是 Mac：`inspectMac` 在
  `/Applications` 认到一份就 `break`，`~/Applications` 那份根本不看，开着也不算。现在两处都认，显示、打开照旧用 `/Applications`
  那份，开没开两份一起算，换线路、换密钥照旧等它退出。打开之前那次（`launch`）加 `firstCopy`，Mac 上照旧认到第一份就停，不为另一份
  多跑一遍 Gatekeeper 核对。没过核对的那份不算（跟 Windows 上被拒的登记一样）。两份时 C11 每 5 分钟只看一份的进程
  （`stillRunning`），另一份开着就退成整轮检测，结论照样对，只是多一次盘点。
