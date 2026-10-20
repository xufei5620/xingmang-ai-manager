// 检查、反馈与客服、设置三页各在自己的文件里（#1070 第 11 步，原样搬出）：检查页 features/health/HealthPage.tsx，
// 反馈与客服 features/feedback/FeedbackPage.tsx，设置页 features/settings/SettingsPage.tsx；各业务页共用的
// BusinessActions 等参数类型在 business-actions.ts，装工具那几句结果和「安装指南」落哪一章在
// features/tools/install-result.ts。这里只转出，原来从这里 import 的地方不用改。
export type { BusinessActions, FeedbackRequest, FeedbackSupport, ToolInstallOutcome } from './business-actions'
export { createSettingsQueue } from './features/app/settings-queue'
export {
  HealthPage,
  connectionRowStatus,
  diagnosticHasFix,
  diagnosticSection,
  diagnosticTarget,
  sortConnectionRows,
  sortDiagnosticsBySeverity,
} from './features/health/HealthPage'
export {
  FeedbackPage,
  buildFeedbackMessage,
  feedbackCopyNotice,
  feedbackErrorCount,
  feedbackExportNotice,
} from './features/feedback/FeedbackPage'
export { installGuideTopic, installJobRunning, installResultMessage } from './features/tools/install-result'
export {
  OnboardingGuideRow,
  OnboardingTourRow,
  SettingsPage,
  launchShortcutMeta,
  settingsPageLead,
  shortcutRows,
} from './features/settings/SettingsPage'
export { tutorialTopics } from './registry/tutorials'
export { TutorialPage } from './features/tutorial/TutorialPage'
