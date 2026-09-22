import { cliCatalog, providerIds, type ProviderId } from './catalog'
import { connectionCheckLayerLabels, type ConnectionCheckLayer } from './connection-check'
import type { DiagnosticState, DiagnosticsReport } from './diagnostics'

/**
 * 反馈报告里「最近一次自检」那段的纯函数构造器。客服拿到报告之后要回答的第二
 * 个问题是「到底能不能用」——这答案用户其实已经在「检查」页点出来过一次，没必
 * 要再让他截一张图发过来。
 *
 * 刻意不做的事：不在生成报告时重跑自检、不发任何网络请求（只读主进程内存里已
 * 有的上一份结果），不写 Key、不写地址、不写站点名（I13、连接自检的 siteId 与
 * endpoint 都不取），也不带上每项的 nextStep 原文——那几句是给用户在界面上照着
 * 做的，进报告只会把日志挤到更靠后。
 */

/** 最近一次连接自检里允许进报告的那几项。刻意不含 endpoint / siteId / detail。 */
export interface FeedbackConnectionRecord {
  ok: boolean
  layer: ConnectionCheckLayer
  summary: string
  checkedAt: string
}

export interface FeedbackSelfCheckInput {
  /** 「检查」页最近一次跑出来的报告；没跑过传 null。 */
  report: DiagnosticsReport | null
  /** 读一个工具最近一次连接自检的结果，没跑过返回 null。 */
  readConnection: (provider: ProviderId) => FeedbackConnectionRecord | null
  now: Date
  /** 与诊断导出同款的脱敏，由主进程注入；缺省不改写（纯函数测试用）。 */
  redact?: (value: string) => string
}

/**
 * 与「检查」页结果条上的三个词一致（`pages-maintenance.tsx`）：报告里换一套说法，
 * 客服和用户对着同一台机器会得出两个结论。
 */
const stateLabels: Readonly<Record<DiagnosticState, string>> = {
  pass: '正常',
  warn: '需留意',
  fail: '待处理',
  error: '待处理',
}

const NOT_CHECKED = '还没做过自检，可以在软件里打开「检查」页点一次「开始检查」，再导出一份报告。'

/**
 * 隔夜的结果照发无妨——用户往往是先检查、隔天才想起来找客服；但客服得知道这
 * 一份说的是不是今天的机器，所以超过一天就明写。
 */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000

function ageSuffix(timestamp: string, now: Date): string {
  const at = Date.parse(timestamp)
  if (!Number.isFinite(at)) return ''
  return now.getTime() - at > STALE_AFTER_MS ? '（较早）' : ''
}

function connectionLabel(record: FeedbackConnectionRecord): string {
  if (record.ok) return '正常'
  // 「还没配」不是故障，跟结果页一样不按失败说（features/tools/connection-check.ts）。
  if (record.layer === 'unconfigured') return '未配置'
  return `${connectionCheckLayerLabels[record.layer]}有问题`
}

function diagnosticLine(
  item: DiagnosticsReport['items'][number],
  redact: (value: string) => string,
): string {
  const label = stateLabels[item.state]
  const summary = redact(item.summary).trim()
  return summary ? `${item.title}: ${label}，${summary}` : `${item.title}: ${label}`
}

function connectionLine(
  provider: ProviderId,
  record: FeedbackConnectionRecord | null,
  now: Date,
  redact: (value: string) => string,
): string {
  const name = `${cliCatalog[provider].name} 连接自检`
  if (!record) return `${name}: 未自检`
  const summary = redact(record.summary).trim()
  const head = summary ? `${connectionLabel(record)}，${summary}` : connectionLabel(record)
  return `${name}: ${head}（${record.checkedAt}${ageSuffix(record.checkedAt, now)}）`
}

function readConnectionQuietly(
  provider: ProviderId,
  read: FeedbackSelfCheckInput['readConnection'],
): FeedbackConnectionRecord | null {
  try {
    return read(provider)
  } catch {
    // 一个工具的结果取不出来不该让整段（更不该让整份报告）失败。
    return null
  }
}

export function buildFeedbackSelfCheckLines(input: FeedbackSelfCheckInput): string[] {
  const redact = input.redact ?? ((value: string) => value)
  const connections = providerIds.map((provider) => ({
    provider,
    record: readConnectionQuietly(provider, input.readConnection),
  }))
  const checked = connections.filter((entry) => entry.record)
  if (!input.report && !checked.length) return [NOT_CHECKED]

  const lines: string[] = []
  if (input.report) {
    const generatedAt = input.report.generatedAt
    lines.push(`检查时间: ${generatedAt}${ageSuffix(generatedAt, input.now)}`)
    for (const item of input.report.items) lines.push(diagnosticLine(item, redact))
  } else {
    lines.push('检查时间: 还没在「检查」页做过检查')
  }
  // 一个都没自检过时不铺四行「未自检」：那只会让报告显得更长而不是更清楚。
  if (checked.length) {
    for (const entry of connections) {
      lines.push(connectionLine(entry.provider, entry.record, input.now, redact))
    }
  }
  return lines
}
