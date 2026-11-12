// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

// 「复制给客服」复制出去的那一段（J1）。以前页面自己拼、自己写剪贴板：客户点完要等主进程现生成报告，
// 慢的电脑好几秒，这几秒切去微信等着粘，窗口没了焦点，页面写剪贴板被拒，复制失败、客服窗口也不开。
// 现在拼和写都在主进程（ipc/handlers/runtime-logs.ts），页面只交客户填的那几样；留言类型的说法放这里，
// 页面那一排选项和主进程拼的第一行用同一份，渲染层也就给不了这三样以外的第一行。
import { redactSecretPatterns } from './redaction-patterns'

export type FeedbackMessageType = 'bug' | 'idea' | 'other'

/** 留言的类型，复制给客服时写在第一行。 */
const feedbackMessageTypeLabels: Readonly<Record<FeedbackMessageType, string>> = {
  bug: '遇到问题',
  idea: '功能建议',
  other: '其他',
}

/** 留言框上那一排选项，次序就是摆的次序。 */
export const feedbackMessageTypes: ReadonlyArray<{ value: FeedbackMessageType; label: string }> = [
  { value: 'bug', label: feedbackMessageTypeLabels.bug },
  { value: 'idea', label: feedbackMessageTypeLabels.idea },
  { value: 'other', label: feedbackMessageTypeLabels.other },
]

export function isFeedbackMessageType(value: unknown): value is FeedbackMessageType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(feedbackMessageTypeLabels, value)
}

/**
 * v4 第 10 批按问 5：不往服务器提交，客户自己发给客服。类型、客户写的、联系方式、身份行、最近一次出错；
 * 勾了「附带反馈报告」再接上整份反馈报告（主进程已经脱敏）。
 * 客户自己写的那几行再过一遍打码表（I13）：描述里偶尔会贴上 sk-… 或 Bearer …。
 */
export function buildFeedbackMessage(input: {
  type: FeedbackMessageType
  description: string
  contact?: string | undefined
  identity?: string | undefined
  lastFailure?: string | undefined
  report?: string | undefined
  /** 勾了「附带反馈报告」但这次没生成出来：末尾说一句，客服不会当成客户忘了勾。缺省 = 不说。 */
  reportMissing?: boolean
}): string {
  const lines = [`留言反馈 · ${feedbackMessageTypeLabels[input.type]}`, input.description.trim()]
  const contact = input.contact?.trim()
  if (contact) lines.push(`联系方式：${contact}`)
  if (input.identity) lines.push(input.identity)
  if (input.lastFailure) lines.push(input.lastFailure)
  if (input.reportMissing) lines.push('反馈报告：这次没生成出来')
  const head = redactSecretPatterns(lines.join('\n'))
  return input.report ? `${head}\n\n${input.report}` : head
}
