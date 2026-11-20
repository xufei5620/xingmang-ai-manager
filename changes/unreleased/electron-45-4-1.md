## 用户

- 软件自带的网页内核更新到最新的安全补丁版，付款页和画布都用上最新的安全修复。

## 开发

- Electron 45.1.0 升到 45.4.1（Chromium 156.0.8078.100、Node 24.22.3），0.2.25 总单第一档第 2 项。0.2.24 定版时停在
  45.1.0 没升（当时 45.2.0 已出 19 天，超过 `docs/RELEASING.md` 的两周规矩），这次补上；electron 自己的依赖没变，锁文件只改 electron 一条。
- 45.2 ~ 45.4 里跟我们有关的上游修复：`ses.setProxy()` 设的代理在网络服务重启后不再丢（electron/electron#55810，线路切换、付款窗口和自动更新都靠它）、
  退出前把 cookie 写回磁盘（electron/electron#55773，开票窗口按账号持久的分区）、`net.fetch` 上传体出错时会 reject 而不是挂住（electron/electron#55691）、
  重定向时也按 webRequest 删请求头（electron/electron#55922）、拉黑已吊销的 eMudhra 中间证书（electron/electron#55742）、Windows 资源管理器重启后托盘提示
  恢复（electron/electron#55834），外加几批 Chromium / V8 安全补丁。
- 升之前按惯例查了 Linux zip 里的文件权限（读压缩包中央目录）：45.1.0 是 0666/0777，45.2.3、45.3.4、45.4.1 的 x64 与
  arm64 都回到 0644/0755。`scripts/linux-payload-modes.cjs` 的收紧照留（上游没承诺不再变），只改了注释里的版本说明。
