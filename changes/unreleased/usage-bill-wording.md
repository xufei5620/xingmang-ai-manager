## 开发

- 0.2.24 深查改字批次 Z05（W10 W45 W46 W73 W74 W75 D22 D57 D58），只动 `features/account/` 用量账单这一块和 `registry/business.ts` 的「生成任务」落点。
- D58：`UsageDetails.tsx` 计费明细里的倍率改用 `usageRatioText`，跟「分组」那一行同一种写法；首字响应用新的 `usageSecondsText`（毫秒换成秒，留一位小数）。
- D57：历史账号筛选框下面那句改由 `usage.ts` 的 `usageCalendarNote` 给出：本机此刻的钟跟北京时间一样（含香港这类同一个钟的时区）就不提时区，不一样才补「按这台电脑的时间算。」，认不出的时区按不一样处理。
- W75 / D22：顶部搜索的落点改名「生成任务」，旧名「异步任务」留在搜索词里，老客户照旧搜得到。系统通知标题「异步任务已完成」（`electron/platform/notifications.ts`）不在两张单子上，没动。
