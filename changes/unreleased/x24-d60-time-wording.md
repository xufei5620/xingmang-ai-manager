## 开发

- 0.2.24 决定单批次 X24（D60 其余，出处时间数字格式.md N-18～N-20、N-22、N-23）。给客户看的那句并进了 `home-recent-time-milliseconds.md`（「## 用户」已满 60 条）。
- 登录设备（`account-center.ts` 的 `deviceActivityText`）：不到 5 分钟才写「刚刚活动」，5～59 分钟写「N 分钟前活动」，小时、天照旧。
- 公告时间线（`newapi-announcements.ts` 的 `formatTimelineDate`）：绝对时间改走 `formatClockTime`（「9月9日 20:00 · 3 天前」「今天 11:30 · 30 分钟前」），
  30 天以上只写日期（「2025年11月20日 18:00」），不再按 30 天一个月折算出「12 个月前」。列表右边的短日期原来是从这句 `.slice(5, 10)` 截出来的，
  换成单独的 `formatTimelineListDate`，照旧写「09-09」，没改。
- 只写钟点的两处：余额鼠标提示（`balance-status.ts`）和帮助框「最近一次出错」（`SupportIdentity.tsx`）今天的照旧，
  不是今天的换成 `formatClockTime`（「最后更新于 昨天 14:05」「最近一次出错：昨天 14:37 ……」）。新加的 `calendar-time.ts` 的 `calendarDaysBefore` 只用来分出「不是今天」。
- 首页招呼（`model.ts` 的 `greeting`）：0～5 点说「晚上好」。
- 用量账单「24 小时」那一档不写「日均」那行小字（`usage.ts` 新加 `usageDailyAverageText`）。
