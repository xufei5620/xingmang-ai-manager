## 开发

- `#265` 把夹具等待门禁改成扫描实际套件之后，查出另外四份浏览器套件仍拿被测元素当挂载等待、用的是 Playwright 默认的 30 秒：`src/renderer-v2/features/acceleration/browser-check.mjs`（等加速导航）、`features/shell/announcement-persistence.browser-check.mjs`（等公告按钮）、`features/shell/newapi-announcements.browser-check.mjs`（等 `before()` 里的解析器 import）、`ui/browser-check.mjs`（等组件检阅页标题）。Windows 冷跑撞上 30 秒时，失败都被报成那个元素没出现，看着像功能坏了。四份现在都先等挂载、用 `e2e/fixture-readiness.mjs` 的共享预算，挂载之后的断言一律保持原有超时。
- 挂载等待本身也收进 `e2e/fixture-readiness.mjs`，导出 `waitForFixtureMount()`：默认等 `#root` 出现首次提交，轮询放在 Node 侧——装了 `page.clock` 的页面定时器与 `requestAnimationFrame` 是暂停的，加速页夹具正是在导航前冻结了两者。`src/renderer-v2/testing/app-check.mjs` 原先自己写的那份轮询改为调用它，只保留自己那条「宿主全局装好了没有」的判定。
- 门禁跟着改两处：判定「接没接预算」现在认 `fixtureReadyTimeoutMs` 或 `waitForFixtureMount` 任一；「不许写死等待」收窄成只拒绝 >= 30000 的数字，因为短于 Playwright 默认值的超时是「要求某件事快点发生」的断言，与挂载等待正好相反（`ui/browser-check.mjs` 断言提示条 4 秒内消失就是这种）。两条都补了自测。
- 门禁的欠账表清空到只剩 `e2e/canvas-group-refresh.mjs`，按项目约定画布不动，原因写在表里。
