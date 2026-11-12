## 开发

- 修 PX-2（`0.2.24-深查/代理.md`，严重）：付款窗口每次开一个新分区（`xingmang-payment-<uuid>`），Electron 每个分区各有
  各的代理设置，新分区默认跟随系统代理；星芒的「代理连不上改直连」（`proxy-bypass.ts`）只改 `session.defaultSession`。
  系统代理指着一个已经关掉的代理软件时，下单走账号接口能成功，付款窗口却又走回那个代理，报 `ERR_PROXY_CONNECTION_FAILED`、
  「支付页面打开失败」，钱充不进去。`createPaymentWindowController` 加可选的 `proxyMode(): 'direct' | 'system'`（缺省
  `system`），每次 `loadURL` 之前按它 `session.setProxy({ mode })`；`main.ts` 交 `proxyBypass.active() ? 'direct' : 'system'`。
  只是连星芒站点那一路直连（`siteDirect()`，代理开着、只是不转发星芒）时付款商的页面照旧经代理走。设不上照旧打开（就是
  以前的样子）；设的这一下里又开了新的付款或换了账号，作废的窗口不再加载。不加 preload，导航白名单、权限、下载照旧全拦，
  界面字没变。
- 沙箱里用 Electron 45.1.0 真跑过（xvfb，系统代理用环境变量指向一个没在听的端口，默认会话已改直连，本机自签证书的付款页）：
  main 0844053 那版报 `ERR_PROXY_CONNECTION_FAILED`；改后 `proxyMode` 给 `direct` 时 4 次都打开了、付款分区 `resolveProxy`
  是 `DIRECT`，给 `system` 时照旧打不开。Windows、Mac 的系统代理没真机演过。
