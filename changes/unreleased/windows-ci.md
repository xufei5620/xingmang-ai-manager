## 开发

- 浏览器夹具的「挂载完成」等待不再借用 Playwright 的 30 秒动作默认值，改为 `e2e/fixture-readiness.mjs` 的共享预算
  （默认 90 秒，`XINGMANG_FIXTURE_READY_TIMEOUT_MS` 可覆盖），六个 `test:ui` 套件与 `app-check.mjs` 共用；挂载之后的
  行为断言一律保持 30 秒默认值。Windows runner 上冷开一个页面比温启动慢一个数量级（quality #264 的
  `maintenance-pages-interactions.test.mjs` 一次 `openFixture` 超过 30 秒，同文件两条温启动用例各 0.4~0.7 秒），
  卡住的是挂载，报出来的却是它后面那条断言。
- `app-check.mjs` 的 `open()` 不再拿 `page.goto` 的 `load` 当夹具就绪，改为轮询夹具全局与已渲染的 root，并在
  `before` 里预热一次 Vite 依赖优化。Vite 发现新依赖会在 `load` 之后整页 reload，这正是
  `window.fixtureSupportQrCode is not a function`（quality #241）与首个参数化用例 30 秒超时、同组另外四个各
  2.3 秒（quality #284）的来源。轮询放在 Node 侧而不是页内，因为装了 `page.clock` 的页面定时器与 rAF 是暂停的。
- `e2e/window-close-smoke.mjs` 的主进程控制通道整体加 try/catch：命令文件读取与删除失败改为下一拍重试并记进
  证据文件（主进程只注册 `uncaughtExceptionMonitor`，此前抛出即终止，症状只剩「命令未被回执」）；`waitUntil`
  的默认预算 15 → 30 秒（`XINGMANG_SMOKE_COMMAND_TIMEOUT_MS` 可覆盖，仍然有界），应用已退出时立刻带退出码
  报错而不是耗完预算；并把主进程自己的 stdout/stderr 转发到日志。
- `scripts/ci-workflow-config.test.cjs` 补两条门禁，钉住上述夹具预算与关窗冒烟的容错，防止回退到裸默认值。
