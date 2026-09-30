## 开发

- Windows 的 renderer-v2 浏览器分片拆成两片：`test:v2:browser:fixture`（共用默认 Vite 依赖缓存的
  browser-check 与最后的 app-check.mjs，顺序不变，上限仍 18 分钟）和 `test:v2:browser:e2e`（两份
  自带 cacheDir 的 e2e 套件，上限 10 分钟）。原来整片在 #712 上跑了 17 分 18 秒，在 #714 上两次
  撞满 18 分钟（超时前用例全过）。不跳过测试、不调上限；`ci-workflow-config.test.cjs` 钉住两片之和
  等于 `test:v2:browser`、fixture 片保持原顺序且 app-check 最后、离开的套件必须自带 cacheDir。
