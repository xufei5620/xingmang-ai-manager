import { describe, expect, it } from 'vitest'
import type { CanvasRunChargeEvent, CanvasRunRecord } from '../host'
import {
  canvasRunChargeHint,
  canvasRunChargeText,
  canvasRunNodeCharge,
  canvasRunRecordCharge,
  latestCanvasNodeCharges,
  mergeCanvasRunChargeEvent,
  parseCanvasRunChargeEvent,
} from './run-charge'

// 跑完以后的「实扣」（桌面仓画布完善第 2b 条第 3 步）。

function attempt(attemptId: string, extra: Partial<CanvasRunRecord['nodes'][number]['attempts'][number]> = {}): CanvasRunRecord['nodes'][number]['attempts'][number] {
  return { attemptId, fingerprint: 'f'.repeat(64), state: 'succeeded', startedAt: '2026-11-10T05:00:00.000Z', completedAt: '2026-11-10T05:00:05.000Z', durationMs: 5_000, cached: false, candidates: [], ...extra }
}

function record(runId: string, startedAt: string, nodes: CanvasRunRecord['nodes']): CanvasRunRecord {
  return { version: 1, userId: 7, ownerId: 9, runId, graphRevision: 'graph-1', scope: { kind: 'all' }, status: 'succeeded', createdAt: startedAt, startedAt, nodes, events: [] }
}

function chargeEvent(extra: Partial<CanvasRunChargeEvent> = {}): CanvasRunChargeEvent {
  return {
    version: 1, type: 'run-charge', runId: 'run-1', graphRevision: 'graph-1', sequence: 9, at: '2026-11-10T05:00:12.000Z',
    charge: { state: 'unmatched', usd: 0.12, unmatchedAttempts: 1, checkedAt: '2026-11-10T05:00:12.000Z' },
    attempts: [
      { nodeId: 'image', attemptId: 'a1', charge: { state: 'settled', usd: 0.06 } },
      { nodeId: 'image', attemptId: 'a2', charge: { state: 'settled', usd: 0.06 } },
      { nodeId: 'image', attemptId: 'a3', charge: { state: 'unmatched', usd: 0 } },
    ],
    ...extra,
  }
}

describe('canvas run charge', () => {
  it('reads the charge event the desktop pushes and refuses anything malformed', () => {
    expect(parseCanvasRunChargeEvent(chargeEvent())).toEqual(chargeEvent())
    expect(parseCanvasRunChargeEvent({ ...chargeEvent(), extra: 'dropped' })).toEqual(chargeEvent())
    const malformed: unknown[] = [
      null, 'run-charge', { ...chargeEvent(), type: 'run-terminal' }, { ...chargeEvent(), version: 2 },
      { ...chargeEvent(), runId: '' }, { ...chargeEvent(), graphRevision: 'g'.repeat(257) }, { ...chargeEvent(), at: 'yesterday' },
      { ...chargeEvent(), sequence: -1 }, { ...chargeEvent(), sequence: 1.5 },
      { ...chargeEvent(), charge: { ...chargeEvent().charge, usd: -0.01 } },
      { ...chargeEvent(), charge: { ...chargeEvent().charge, usd: Number.NaN } },
      { ...chargeEvent(), charge: { ...chargeEvent().charge, usd: 1_000_001 } },
      { ...chargeEvent(), charge: { ...chargeEvent().charge, state: 'paid' } },
      { ...chargeEvent(), charge: { ...chargeEvent().charge, unmatchedAttempts: 0.5 } },
      { ...chargeEvent(), charge: { ...chargeEvent().charge, approximate: false } },
      { ...chargeEvent(), charge: { ...chargeEvent().charge, checkedAt: 7 } },
      { ...chargeEvent(), attempts: {} },
      { ...chargeEvent(), attempts: Array.from({ length: 4_097 }, () => chargeEvent().attempts[0]) },
      { ...chargeEvent(), attempts: [{ nodeId: 'image', attemptId: 'a1', charge: { state: 'settled', usd: '0.06' } }] },
      { ...chargeEvent(), attempts: [{ nodeId: 'image', charge: { state: 'settled', usd: 0.06 } }] },
    ]
    for (const value of malformed) expect(parseCanvasRunChargeEvent(value)).toBeNull()
  })

  it('writes the charge into the run and the attempts it names, and leaves everything else as it was', () => {
    const untouched = record('run-2', '2026-11-10T04:00:00.000Z', [{ nodeId: 'image', kind: 'image', state: 'succeeded', attempts: [attempt('a1')] }])
    const text = { nodeId: 'text', kind: 'text', state: 'succeeded' as const, attempts: [attempt('t1')] }
    const records = [
      record('run-1', '2026-11-10T05:00:00.000Z', [{ nodeId: 'image', kind: 'image', state: 'succeeded', attempts: [attempt('a1'), attempt('a2'), attempt('a3')] }, text]),
      untouched,
    ]
    const merged = mergeCanvasRunChargeEvent(records, chargeEvent())
    expect(merged[0].charge).toEqual(chargeEvent().charge)
    expect(merged[0].nodes[0].attempts.map((entry) => entry.charge)).toEqual(chargeEvent().attempts.map((entry) => entry.charge))
    expect(merged[0].nodes[1]).toBe(text)
    expect(merged[1]).toBe(untouched)
    expect(records[0].charge).toBeUndefined()
    // Not this run, another graph revision or a broken answer: nothing changes, not even the list.
    expect(mergeCanvasRunChargeEvent(records, chargeEvent({ runId: 'run-9' }))).toBe(records)
    expect(mergeCanvasRunChargeEvent(records, chargeEvent({ graphRevision: 'graph-2' }))).toBe(records)
    expect(mergeCanvasRunChargeEvent(records, { ...chargeEvent(), charge: null })).toBe(records)
  })

  it('totals a run and a node from what the host checked, and nothing before it has', () => {
    const run = mergeCanvasRunChargeEvent([record('run-1', '2026-11-10T05:00:00.000Z', [{ nodeId: 'image', kind: 'image', state: 'succeeded', attempts: [attempt('a1'), attempt('a2'), attempt('a3')] }])], chargeEvent())[0]
    expect(canvasRunRecordCharge(run)).toEqual({ usd: 0.12, settledAttempts: 2, unmatchedAttempts: 1, approximate: false })
    expect(canvasRunNodeCharge(run.nodes[0])).toEqual({ usd: 0.12, settledAttempts: 2, unmatchedAttempts: 1, approximate: false })
    const unchecked = record('run-1', '2026-11-10T05:00:00.000Z', [{ nodeId: 'image', kind: 'image', state: 'succeeded', attempts: [attempt('a1')] }])
    expect(canvasRunRecordCharge(unchecked)).toBeNull()
    expect(canvasRunNodeCharge(unchecked.nodes[0])).toBeNull()
  })

  it('gives each node the charge of its latest run that really ran it, never an older one in its place', () => {
    const settled = { state: 'settled' as const, usd: 0.06 }
    const records = [
      // Newest: a cache hit only, so it says nothing about what the current result cost.
      record('run-3', '2026-11-10T07:00:00.000Z', [{ nodeId: 'image', kind: 'image', state: 'cached', attempts: [attempt('c1', { cached: true })] }]),
      record('run-1', '2026-11-10T05:00:00.000Z', [
        { nodeId: 'image', kind: 'image', state: 'succeeded', attempts: [attempt('a1', { charge: { state: 'settled', usd: 0.8, approximate: true } })] },
        { nodeId: 'video', kind: 'video', state: 'succeeded', attempts: [attempt('v1', { charge: settled })] },
      ]),
      // The video's latest paid run has not been checked yet: no charge, not run-1's.
      record('run-2', '2026-11-10T06:00:00.000Z', [{ nodeId: 'video', kind: 'video', state: 'succeeded', attempts: [attempt('v2')] }]),
    ]
    const charges = latestCanvasNodeCharges(records)
    expect(charges.get('image')).toEqual({ usd: 0.8, settledAttempts: 1, unmatchedAttempts: 0, approximate: true })
    expect(charges.has('video')).toBe(false)
    expect(latestCanvasNodeCharges([])).toEqual(new Map())
  })

  it('writes 实扣 the way the balance chip writes money, and 待核对 for what did not match', () => {
    const total = (usd: number, settledAttempts: number, unmatchedAttempts = 0, approximate = false) => ({ usd, settledAttempts, unmatchedAttempts, approximate })
    expect(canvasRunChargeText(total(0.18, 3), { prefix: true })).toBe('实扣 $0.18')
    expect(canvasRunChargeText(total(0.18, 3))).toBe('$0.18')
    expect(canvasRunChargeText(total(1234.5, 3), { prefix: true })).toBe('实扣 $1,234.50')
    expect(canvasRunChargeText(total(0.8, 1, 0, true), { prefix: true })).toBe('实扣约 $0.80')
    expect(canvasRunChargeText(total(0.8, 1, 0, true))).toBe('约 $0.80')
    expect(canvasRunChargeText(total(0.06, 1, 2), { prefix: true })).toBe('实扣 $0.06，另有 2 次待核对')
    expect(canvasRunChargeText(total(0.06, 1, 2))).toBe('$0.06，另有 2 次待核对')
    expect(canvasRunChargeText(total(0, 0, 3), { prefix: true })).toBe('实扣待核对')
    expect(canvasRunChargeText(total(0, 0, 3))).toBe('待核对')
    expect(canvasRunChargeText(total(0.003, 1), { prefix: true })).toBe('实扣不到 $0.01')
    expect(canvasRunChargeText(total(0.003, 1))).toBe('不到 $0.01')
    // A request that failed and was not charged really cost nothing.
    expect(canvasRunChargeText(total(0, 1))).toBe('$0.00')
    expect(canvasRunChargeHint(total(0.18, 3))).toBe('到你账号的用量记录里按请求号对出来的实扣；待核对是没对上的，以用量页为准')
    expect(canvasRunChargeHint(total(0.8, 1, 0, true))).toBe('到你账号的用量记录里按请求号对出来的实扣；待核对是没对上的，以用量页为准。视频任务站点事后还可能退补，所以标「约」')
  })
})
