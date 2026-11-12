## 开发

- 修 PX-2 的同类问题（`0.2.24-深查/代理.md`）：开票窗口（`invoice-portal-window.ts`）用自己的持久分区
  `persist:xingmang-invoice-<摘要>`，跟付款窗口一样不跟星芒的「代理连不上改直连」（`proxy-bypass.ts` 只改
  `session.defaultSession`）。系统代理指着一个已经关掉的代理软件时，点「开发票」报 `ERR_PROXY_CONNECTION_FAILED`、
  「没能打开开票中心」。`createInvoicePortalWindowController` 加可选的 `proxyMode`（缺省 `system`），每开一个新窗口、
  `loadURL` 之前都按它设一次（分区是持久的，上一次设的连法会留着，所以每次重设）；设的这一下里换了账号、退出了，
  作废的窗口不再加载。设连法那一行和付款窗口共用 `payment-window.ts` 新导出的 `applyPageProxyMode`（设不上照旧打开，
  同步抛错也吞掉），连法也共用 `main.ts` 里同一个 `externalPageProxyMode()`（`proxyBypass.active() ? 'direct' : 'system'`；
  只是连星芒站点那一路直连时开票中心照旧经代理走）。不加 preload，导航白名单、权限、下载照旧全拦，界面字没变。
- 沙箱里用 Electron 45.1.0 真跑过（xvfb，系统代理用环境变量指向一个没在听的端口，默认会话已改直连，
  `host-resolver-rules` 把开票中心地址指到本机自签证书的假页面）：main 那版报 `ERR_PROXY_CONNECTION_FAILED`，开票分区
  `resolveProxy` 是 `PROXY 127.0.0.1:9`；改后 `proxyMode` 给 `direct` 时打开了、读得到页面内容、分区是 `DIRECT`，给
  `system` 时照旧打不开。Windows、Mac 的系统代理没真机演过。
