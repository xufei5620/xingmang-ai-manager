## 开发

- `e2e/maintenance-layout.test.mjs` 改为整个文件共用一个 page：`browser.newPage()` 每次都新建
  BrowserContext，HTTP 缓存是空的，整张模块图要从 Vite dev server 重新取一遍，Windows runner 上
  好几个 e2e 文件并行跑时第二次冷开连 `fixtureReadyTimeoutMs`（90 秒）都不够（quality run
  35423428733：同一文件第一个用例 4.1 秒通过，第二个卡满 90 秒超时）。现在只在 `before` 里挂载
  一次，用例之间改视口宽度切换窄屏/宽屏分支。断言与超时预算都没有放宽。
