## 用户

- 开机时右上角的提示最多摊开两张，要你选的排在最前，其余收进「还有 N 条提示」，点开能看全、也能收起；屏幕小或开了大字时，卡片区放不下会在区里滚动，最后一张的按钮也点得到。

## 开发

- `StartupNotices.tsx`：同时最多摊开 `STARTUP_NOTICE_VISIBLE_LIMIT`（2）张，维护提示占一个位置；`orderStartupNotices` 按无缺省的 `Record<StartupCheckId, number>` 排先后（要选的 → 出事的 → 有空看的 → 纯告知），同档保持先来后到，新增提示类型时编译器会要求给它排位；多出来的折进「还有 N 条提示」按钮（`startup-notices-toggle`，带 `aria-expanded`）。
- `shell.css`：`.v2-startup-notices` 加 `max-height: calc(100vh - 120px)`，卡片摞放进 `.v2-startup-notices-list` 在区内滚动；容器仍不吃指针事件，只有卡片区和折叠按钮吃。提示类型定义（`startup-notice.ts`）没动。
