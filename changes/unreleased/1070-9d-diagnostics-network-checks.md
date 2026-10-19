## 开发

- 拆 `diagnostics.ts`（#1070 第 9 步，第四块）：「网络与代理」那几项（星芒服务连接、安全证书、Clash Verge 的 TUN、电脑里的代理设置）连同只有它们用的常量和小工具（Clash 配置的找法和 `parseClashTunConfig`、代理变量的探法和 `windowsProxySettingsOutcome`、软件自己走哪条代理的 `inspectAppProxyRoute` / `withAppProxyRoute`、两条线路状态页的探测地址和结论、本机时钟偏差、线路切换的说法、安全证书那一项的 Node 握手探测和 `reconcileCertificateTrustWithNetwork`）搬进新文件 `electron/diagnostics-network-checks.ts`。原清单里这四项不挨着（中间隔着磁盘那几项），所以分成 `buildNetworkChecks(context)`（星芒服务连接、安全证书）和 `buildProxyChecks(context)`（TUN、代理设置）两个，`runDiagnostics` 在原来的两个位置各展开一个，次序不变；收尾时照旧调 `reconcileCertificateTrustWithNetwork`。新文件只 import `diagnostics.ts` 的类型，搬走的十三个导出名和 `AppProxyRoute` 类型 `diagnostics.ts` 照旧转出。
- 搬运用脚本按原文件行号整段复制，逐段比对一字没改。Windows 专属的两段原样搬过去，没改：`windowsProxySettingsOutcome`（读当前账号和整台电脑各设了什么代理，details 只写变量名和本机端口）；安全证书那一项「以管理员身份打开时不起进程去量、直接给结论」的分支。量证书时起 Node 照旧走 `runCommand` + argv、`commandEnvironment`。
- 改了三处注释里的文件名（`relay-line-fetch.ts`、`connection-check.ts`、`relay-route-controller.ts` 说「诊断那一项在哪」的地方），以及 `docs/module-map/` 两份文档。
- 测试：这几项的行为由 `diagnostics.test.ts` 原有的用例钉着（两条线路、退回、加速时、时钟偏差、证书的几种结论、TUN、代理设置的几种情况）；另用八种情况把整份报告和日志搬前搬后各跑一遍逐字比对，一样。
