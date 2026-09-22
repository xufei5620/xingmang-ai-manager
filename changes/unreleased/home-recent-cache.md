## 用户

- 首页的「最近」列表不再每回来一次就重读一遍会话记录：一分钟内直接沿用上次的结果，
  页面之间切来切去更快。装好工具、打开工具、换账号或点「重新检测」之后仍然立刻刷新。

## 开发

- 新增 `src/renderer-v2/features/tools/ttl-cache.ts`：按时间复用结果的读缓存，并发的
  `read` 共用同一趟请求；`invalidate()` 同时让此刻在飞的那一趟作废，它晚回来时既不写回
  缓存也不挡住下一趟（「只认最后一次请求」）。失败不进缓存。
- `features/tools/api.ts` 的 `recent()` 改走这个缓存（`recentSessionsTtlMs` = 60 秒），
  并在 `install` / `uninstall` / `launch` 完成后自动作废；另外导出 `invalidateRecent()`。
- `App.tsx` 增加 `refreshRecent()`：作废缓存的同时递增 `recentRevision` 传给 `Home`，
  让正开着的首页立刻重读。调用点为首页「重新检测」、`syncAfterToolInstalled`
  （覆盖「安装卸载」页那条绕开 `toolsApi` 的安装路径）、账号 scope 变化，以及记录页
  「接着聊」——`SessionsPage` 新增可选的 `onResumed`，经 `BusinessPage` 的
  `onSessionResumed` 透到 `App`。
- 覆盖：`ttl-cache.test.ts` 6 条（命中、过期、并发共用、作废、作废中途的守卫、失败不缓存）、
  `api.test.ts` 新增 9 条、`testing/app-check.mjs` 一条浏览器用例（首页→记录页→首页
  不再读盘，点「重新检测」真去读）。
