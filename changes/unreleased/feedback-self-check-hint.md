## 用户

- 在「反馈」页预览报告时，如果还没做过检查，报告上面会提醒先去「检查」页查一次，点「去检查」直接过去；
  查完再复制或导出，报告里就带着检查结果，客服能少问几句。

## 开发

- 反馈报告「最近一次自检」那段两份真机报告都是空的（第二十六批 C）：检查结果只在主进程内存里，客户导出前
  看不到任何提醒。`runtime-logs:preview-feedback` 的结果多带 `selfChecked`（`FeedbackReportPreview`，可选，
  缺省不提醒），由 `diagnosticsService.hasSelfCheckResult` 按 `feedback-self-check.ts` 的 `hasFeedbackSelfCheck`
  判断，与报告里写不写「还没做过自检」同一个口径；过期重生成的预览同样带上。为 false 时预览弹窗在报告上面
  显示提示和「去检查」（`feedback-report-unchecked` / `feedback-report-go-check`）。生成报告照旧不重跑检查。
- 报告里给客服的那句改成「打开「检查」页，等它查完再导出」：新界面的检查页一打开就自动查，页上叫
  「开始检查」的只有要花额度的「Codex 干活检查」。
