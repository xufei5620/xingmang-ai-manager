## 开发

- T-B1：抽出 `e2e/harness.mjs`，把十四个浏览器套件各写一遍的「Vite dev server + Chromium +
  记录 pageerror 的 page」样板收进一处。此前 `XINGMANG_E2E_CHROMIUM` 的容器兜底（T-S5）与
  pageerror 采集（T-G3）都要逐个文件补，漏了也没人发现。
- T-B2：`v2-business.test.mjs`、`v2-local-avatar.test.mjs` 与
  `scripts/audit/v2-business-screenshots.mjs` 写死的首选端口（5191 / 5196）一律改成
  `port: 0`。`strictPort: false` 下写死端口只会在并行时静默换号，既没保障也没意义。
- T-B5：仓库仍不引入 `playwright.config`，改由 harness 导出默认视口与三档超时常量
  （断言 5 秒、图片类断言 7 秒、导航 30 秒），各套件不再各写一份数字。
- `scripts/ci-workflow-config.test.cjs` 跟着加门禁：`e2e/*.test.mjs` 不许再自己
  `chromium.launch()`（macos-dev-origin 例外，它驱动的是 Electron），harness 自身必须
  采集 pageerror、认容器变量、不写死端口。
