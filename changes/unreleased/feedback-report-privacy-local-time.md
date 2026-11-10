## 开发

- D61（`0.2.24-深查/汇总决定单.md`，出处 `日志和上报.md` R6 后半、R12）：反馈报告「运行环境」段在「运行权限」下面加
  「错误报告：开/关」「匿名使用统计：开/关」两行，报告开头 UTC 那行「生成时间」下面加「生成时间（本机）：2026-11-09 14:05:03 +08:00」
  这样一行。字和冒号照单子逐字；每条日志的时间照旧是 UTC，好跟 Sentry 和服务端日志对。
- 两行开关写的是这次运行真发不发：问的是两个上报器每次发之前问的同一个函数（`main.ts` 抽出的 `crashReportingEnabled`
  和 `usageStatsEnabled`），开发版、本机快包、CI、设了关闭变量的，设置里开着也写「关」。`usageStatsEnabled` 原样挪到
  `diagnostics.attachFeedbackDescribers` 之前，报告接上时它已经在。
- 本机时间由 `runtime-log.ts` 的纯函数 `formatFeedbackLocalTime` 给出，偏移量可以单独传，测试不跟跑测试那台机器的时区走。
  R6 前半（发成功记事件编号）不在这条里。
