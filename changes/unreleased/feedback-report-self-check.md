## 用户

- 「反馈」页导出的报告里多了一段「最近一次自检」：你在「检查」页点过的那次检查，
  每一项的名字、状态和一句结论都会自动附上，连接自检做过的工具也会写上结果，
  发给客服不用再去检查页截图。报告只用本机已经存着的上一次结果，导出时不会重新
  检查、也不会联网；一次都没做过就写一行「还没做过自检」。

## 开发

- 第五批候选 7：`electron/feedback-self-check.ts` 新增纯函数
  `buildFeedbackSelfCheckLines`，把最近一次 `DiagnosticsReport` 与最近一次连接自检
  拼成报告里的「最近一次自检」段；状态词沿用检查页结果条的 正常 / 需留意 / 待处理
  （`error` 与 `fail` 同列「待处理」），连接自检按归因层写「密钥有问题」这类说法，
  `unconfigured` 仍按「未配置」而不是失败。
- `runtime-log.ts` 把原先只服务「工具与配置」的限时取数抽成 `describeSectionLines`，
  新增 `attachSelfCheckDescriber`；两段各自计时，一段超时或抛错不影响另一段，
  都没接上时整段不出现。段落位置在「工具与配置」之后、「运行日志」之前。
- `main.ts` 接线：`latestDiagnostics` 直接复用（诊断导出本来就留着它），
  `diagnosticsService.checkConnection` 顺手把 `{ ok, layer, summary, checkedAt }`
  记进一张按 provider 的表——刻意不留 `endpoint` / `siteId` / `detail`，报告里不出现
  地址与站点名。结论再过一遍 `redactDiagnosticText`（与诊断导出同一份敏感值，I13）。
- 超过 24 小时的结果在时间后标「（较早）」；时间戳解析不出来时不猜，原样写出。
