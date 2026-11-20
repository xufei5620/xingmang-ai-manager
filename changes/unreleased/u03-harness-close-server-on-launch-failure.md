## 开发

- 浏览器测试夹具（`e2e/harness.mjs`）起不来 Chromium 时，`start` 自己把已经起好的 Vite 服务关掉，
  不再留着监听让 `node --test` 的子进程一直不退出、只能等外面的超时（审查总表 U03，总单 80）。
  `stop` 在浏览器关失败时照样关 Vite 服务、原样抛出浏览器那个错，连调两次不会重复关；
  `withBrowserFixture` 把 `start` 放进 try/finally；没 `stop` 就再 `start` 直接报错，不再丢下上一套。
  新增 `e2e/harness.test.mjs`（随 `test:browser` 跑）：假 server / 浏览器数每样各关了几次，
  另起一个真的 Vite、把 Chromium 路径指到不存在的文件，看子进程能不能自己退出（旧代码在这条上挂住，15 秒后被杀）。
