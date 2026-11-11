import type { CanvasRunAttemptCharge, CanvasRunCharge, CanvasRunChargeEvent, CanvasRunRecord } from '../host'
import { accountBalanceText } from './account-summary'

// 跑完以后的「实扣」（桌面仓画布完善第 2b 条第 3 步）。宿主到这个账号自己的用量记录里按请求号对出每次
// 尝试扣了多少，运行结束几秒后推一次；内核只显示。对不上的写「待核对」，不拿预计冒充实扣。

const maximumChargedAttempts = 4_096
const maximumIdentifierLength = 256
// A run that charged more than this is a broken answer rather than a charge.
const maximumChargeUsd = 1_000_000

export interface CanvasRunChargeTotal {
  /** Dollars of the requests the host matched. */
  usd: number
  settledAttempts: number
  /** Paid attempts the host could not match: 待核对. */
  unmatchedAttempts: number
  /** Some matched charge may still be adjusted by the relay (video). */
  approximate: boolean
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumIdentifierLength
}

function dollars(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximumChargeUsd
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
}

function parseAttemptCharge(value: unknown): CanvasRunAttemptCharge | null {
  const entry = recordOf(value)
  if (!entry || (entry.state !== 'settled' && entry.state !== 'unmatched') || !dollars(entry.usd)) return null
  if (entry.approximate !== undefined && entry.approximate !== true) return null
  return { state: entry.state, usd: entry.usd, ...(entry.approximate ? { approximate: true as const } : {}) }
}

/** The host's charge event, narrowed like any other host answer; null when it is not one or is malformed. */
export function parseCanvasRunChargeEvent(value: unknown): CanvasRunChargeEvent | null {
  const event = recordOf(value)
  if (!event || event.type !== 'run-charge' || event.version !== 1) return null
  if (!identifier(event.runId) || !identifier(event.graphRevision) || !timestamp(event.at)) return null
  if (typeof event.sequence !== 'number' || !Number.isSafeInteger(event.sequence) || event.sequence < 0) return null
  const charge = recordOf(event.charge)
  if (!charge || (charge.state !== 'settled' && charge.state !== 'unmatched') || !dollars(charge.usd)) return null
  if (typeof charge.unmatchedAttempts !== 'number' || !Number.isSafeInteger(charge.unmatchedAttempts)
    || charge.unmatchedAttempts < 0 || charge.unmatchedAttempts > maximumChargedAttempts) return null
  if ((charge.approximate !== undefined && charge.approximate !== true) || !timestamp(charge.checkedAt)) return null
  if (!Array.isArray(event.attempts) || event.attempts.length > maximumChargedAttempts) return null
  const attempts: CanvasRunChargeEvent['attempts'] = []
  for (const value of event.attempts) {
    const entry = recordOf(value)
    const attemptCharge = entry ? parseAttemptCharge(entry.charge) : null
    if (!entry || !identifier(entry.nodeId) || !identifier(entry.attemptId) || !attemptCharge) return null
    attempts.push({ nodeId: entry.nodeId, attemptId: entry.attemptId, charge: attemptCharge })
  }
  const runCharge: CanvasRunCharge = {
    state: charge.state,
    usd: charge.usd,
    unmatchedAttempts: charge.unmatchedAttempts,
    ...(charge.approximate ? { approximate: true as const } : {}),
    checkedAt: charge.checkedAt,
  }
  return { version: 1, type: 'run-charge', runId: event.runId, graphRevision: event.graphRevision, sequence: event.sequence, at: event.at, charge: runCharge, attempts }
}

function attemptKey(nodeId: string, attemptId: string): string {
  return `${nodeId}\u0000${attemptId}`
}

/**
 * Writes the host's charge into the run it belongs to. It arrives seconds after
 * the run ended, long after the run stopped being active, so it only touches
 * the run records and never the nodes on the canvas. Records it does not fit
 * stay as they are, and so does the list when nothing matched.
 */
export function mergeCanvasRunChargeEvent(records: CanvasRunRecord[], value: unknown): CanvasRunRecord[] {
  const event = parseCanvasRunChargeEvent(value)
  if (!event) return records
  const charges = new Map(event.attempts.map((entry) => [attemptKey(entry.nodeId, entry.attemptId), entry.charge]))
  let matched = false
  const next = records.map((record) => {
    if (record.runId !== event.runId || record.graphRevision !== event.graphRevision) return record
    matched = true
    return {
      ...record,
      charge: { ...event.charge },
      nodes: record.nodes.map((node) => node.attempts.some((attempt) => charges.has(attemptKey(node.nodeId, attempt.attemptId)))
        ? {
          ...node,
          attempts: node.attempts.map((attempt) => {
            const charge = charges.get(attemptKey(node.nodeId, attempt.attemptId))
            return charge ? { ...attempt, charge: { ...charge } } : attempt
          }),
        }
        : node),
    }
  })
  return matched ? next : records
}

function totalOf(charges: readonly CanvasRunAttemptCharge[]): CanvasRunChargeTotal | null {
  if (charges.length === 0) return null
  return {
    usd: charges.reduce((total, charge) => total + charge.usd, 0),
    settledAttempts: charges.filter((charge) => charge.state === 'settled').length,
    unmatchedAttempts: charges.filter((charge) => charge.state === 'unmatched').length,
    approximate: charges.some((charge) => charge.approximate),
  }
}

/** The whole run's charge; null until the host has checked it, and always on hosts that never do. */
export function canvasRunRecordCharge(record: CanvasRunRecord): CanvasRunChargeTotal | null {
  if (!record.charge) return null
  return {
    usd: record.charge.usd,
    settledAttempts: record.nodes.reduce((total, node) => total + node.attempts.filter((attempt) => attempt.charge?.state === 'settled').length, 0),
    unmatchedAttempts: record.charge.unmatchedAttempts,
    approximate: Boolean(record.charge.approximate),
  }
}

/** One node's charge within a run; null when none of its attempts was charged or checked. */
export function canvasRunNodeCharge(node: CanvasRunRecord['nodes'][number]): CanvasRunChargeTotal | null {
  return totalOf(node.attempts.flatMap((attempt) => attempt.charge ? [attempt.charge] : []))
}

/**
 * 检查器「消耗」：每个节点最近一次真跑过（有不走缓存的尝试）的那次运行里对出来的实扣。那次还没对出来
 * （刚跑完几秒、历史账号、老宿主）就不给，不拿更早一次的冒充。
 */
export function latestCanvasNodeCharges(records: readonly CanvasRunRecord[]): Map<string, CanvasRunChargeTotal> {
  const latest = new Map<string, { startedAt: number; charge: CanvasRunChargeTotal | null }>()
  for (const record of records) {
    const startedAt = Date.parse(record.startedAt)
    if (!Number.isFinite(startedAt)) continue
    for (const node of record.nodes) {
      if (!node.attempts.some((attempt) => !attempt.cached)) continue
      const known = latest.get(node.nodeId)
      if (known && known.startedAt >= startedAt) continue
      latest.set(node.nodeId, { startedAt, charge: canvasRunNodeCharge(node) })
    }
  }
  const charges = new Map<string, CanvasRunChargeTotal>()
  for (const [nodeId, entry] of latest) if (entry.charge) charges.set(nodeId, entry.charge)
  return charges
}

function amountText(total: CanvasRunChargeTotal): string {
  // Two decimals like the balance chip, but a few tenths of a cent must not read as free.
  if (total.usd > 0 && total.usd < 0.005) return '不到 $0.01'
  return `${total.approximate ? '约 ' : ''}${accountBalanceText(total.usd)}`
}

/** 检查器「消耗」写不带前缀的；运行面板写带「实扣」的。 */
export function canvasRunChargeText(total: CanvasRunChargeTotal, options: { prefix?: boolean } = {}): string {
  const lead = options.prefix ? '实扣' : ''
  if (total.settledAttempts === 0 && total.unmatchedAttempts > 0 && total.usd === 0) return `${lead}待核对`
  const amount = amountText(total)
  const main = `${lead}${lead && amount.startsWith('$') ? ' ' : ''}${amount}`
  return total.unmatchedAttempts > 0 ? `${main}，另有 ${total.unmatchedAttempts} 次待核对` : main
}

export function canvasRunChargeHint(total: CanvasRunChargeTotal): string {
  return `到你账号的用量记录里按请求号对出来的实扣；待核对是没对上的，以用量页为准${total.approximate ? '。视频任务站点事后还可能退补，所以标「约」' : ''}`
}
