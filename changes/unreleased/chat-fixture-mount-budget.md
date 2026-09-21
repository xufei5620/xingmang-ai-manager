## 开发

- `src/renderer-v2/features/chat/browser-check.mjs` 的 `open()` 原先拿被测元素 `chat-composer-input` 当挂载等待，用的是 Playwright 默认的 30 秒，没接 `e2e/fixture-readiness.mjs`（#164 起的共享挂载预算）。Windows 冷跑撞上 30 秒就红，失败信息指向元素、看着像聊天页坏了（同一条用例 Linux 本地 12.6 秒通过）。现在改成先等 `#root > *` 挂上、用共享的 `fixtureReadyTimeoutMs`，挂载之后的断言一律保持 30 秒默认值。
- `scripts/ci-workflow-config.test.cjs` 的夹具等待门禁原先只核对一张手写清单，清单漏了谁就看不见谁——聊天夹具就是这么漏掉的。现在改为扫描 `e2e/` 与 `src/renderer-v2/` 下自己开页面的 `.mjs` 套件，每一个都必须落在「已接预算」或「已登记欠账」两张表之一，新增套件两边都不在就会红；已接预算的套件另外不许再写死 `timeout: <数字>`。门禁的判定抽成纯函数并补了自测（写死等待要红、没接预算要红）。
- 扫描顺带查出另外五份同样没接预算的浏览器套件，本 PR 不动它们，先登记进欠账表留待单独处理：`e2e/canvas-group-refresh.mjs`、`src/renderer-v2/features/acceleration/browser-check.mjs`、`src/renderer-v2/features/shell/announcement-persistence.browser-check.mjs`、`src/renderer-v2/features/shell/newapi-announcements.browser-check.mjs`、`src/renderer-v2/ui/browser-check.mjs`。
